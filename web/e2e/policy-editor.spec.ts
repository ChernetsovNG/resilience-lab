import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile, RunSummary } from "../src/api/apiTypes";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1920, height: 1080 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`edits policies, disables a variant, persists, sweeps and confirms dependent removal in ${language}`, async ({ page }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `policy-editor-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root);
      experiment.execution = { ...experiment.execution, warmup: "0s", measurement: "500ms", window: "50ms" };
      const withoutBreaker = ru ? "Без breaker" : "Without breaker";
      experiment.variants = [{ id: "baseline", label: "Baseline", overrides: {} }, { id: "without-breaker", label: withoutBreaker, overrides: {} }];
      experiment.faults = [];
      const original: ModelFile = JSON.parse(await readFile(resolve(root, "retry-storm.model.json"), "utf8"));
      const names: Record<string, string> = { client: "mobile-app", gateway: "api-gateway", middle: "order-service", dependency: "payment-service" };
      const model: ModelFile = { ...original, blocks: Object.fromEntries(Object.entries(original.blocks).map(([id, block]) => [names[id], block])),
        connections: original.connections.map(edge => ({ ...edge, from: names[edge.from], to: names[edge.to],
          id: edge.id === "middle-to-dependency" ? "order-to-payment" : edge.id })),
      };
      model.blocks["payment-service"].params.failureRate = "100%";
      await writeFile(resolve(root, "retry-storm.model.json"), JSON.stringify(model));
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      await writeFile(resolve(root, "retry-storm.layout.json"), JSON.stringify({ schemaVersion: 2, sizes: {}, edges: {}, positions: {
        "mobile-app": { x: 0, y: 160 }, "api-gateway": { x: 260, y: 160 }, "order-service": { x: 520, y: 160 }, "payment-service": { x: 780, y: 160 },
      } }));
      const experimentPath = `${directory}/retry-storm.experiment.json`;
      await page.goto("/");
      await selectExperiment(page, experimentPath);
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector", exact: true });
      const edge = page.getByTestId("canvas-edge-label-order-to-payment");
      const selectCall = async () => {
        await edge.click();
        const parameters = inspector.locator(".inspector-parameters");
        if (await parameters.getAttribute("open") === null) await parameters.locator(":scope > summary").click();
      };
      const breaker = inspector.locator('[data-policy="circuitBreaker"]');
      const fallback = inspector.locator('[data-policy="fallback"]');
      const addButton = inspector.getByRole("button", { name: ru ? "+ Добавить политику" : "+ Add policy", exact: true });
      const removeName = ru ? "Удалить политику" : "Remove policy";
      const breakerName = ru ? "Предохранитель вызовов" : "Circuit breaker";
      const canvasPolicies = page.getByTestId("canvas-policies-order-to-payment");
      const breakerBadge = canvasPolicies.getByRole("button", { name: breakerName, exact: true });
      const add = async (name: string) => {
        await addButton.click(); await inspector.getByRole("menuitem", { name, exact: true }).click();
      };
      const save = async () => {
        await page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true }).click();
        await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      };
      const saved = async () => {
        const document = async (kind: string) => (await (await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.${kind}.json`)}`)).json()).content;
        return { model: (await document("model")).model as ModelFile, experiment: (await document("experiment")).experiment as ExperimentFile };
      };
      const run = async (points: number) => {
        const summaryResponse = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
        const button = page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true });
        await expect(button).toBeEnabled();
        await button.click();
        const summary: RunSummary = await (await summaryResponse).json();
        await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
        expect(summary.variants.map(variant => variant.id)).toEqual(["baseline", "without-breaker"]);
        for (const variant of summary.variants) expect(variant.points).toHaveLength(points);
      };
      await selectCall();
      await expect(inspector.locator("[data-policy]")).toHaveCount(0);
      await expect(addButton).toBeVisible();
      await add(breakerName);
      await expect(breakerBadge).toBeVisible();
      await addButton.click();
      await expect(inspector.getByRole("menuitem", { name: new RegExp(`^${breakerName}`) })).toBeDisabled();
      await expect(inspector.getByRole("menuitem", { name: ru ? /Вывод неисправных экземпляров/ : /Outlier detection/ })).toBeDisabled();
      await expect(inspector.getByRole("menu")).toContainText(ru ? "Только у вызова в группу реплик" : "Only for a call to a replica group");
      if (ru) {
        await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
        await inspector.getByRole("menu").scrollIntoViewIfNeeded();
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("policy-menu-ru.png") });
      }
      await addButton.click();
      await add(ru ? "Заглушка" : "Fallback");
      const reasons = fallback.getByRole("group", { name: ru ? "Срабатывает при" : "Failure reasons", exact: true });
      await expect(reasons.getByRole("checkbox", { name: ru ? "предохранитель вызовов разомкнут" : "circuit breaker open", exact: true })).toBeChecked();
      await reasons.getByRole("checkbox", { name: ru ? "таймаут попытки" : "attempt timeout", exact: true }).check();
      await expect(reasons.getByRole("checkbox", { name: /deadline|дедлайн/i })).toHaveCount(0);
      if (ru) {
        await breaker.locator(":scope > summary").click();
        await fallback.scrollIntoViewIfNeeded();
        await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("policy-fallback-ru.png") });
      }
      await page.getByRole("tab", { name: withoutBreaker, exact: true }).click();
      await selectCall();
      if (await breaker.getAttribute("open") === null) await breaker.locator(":scope > summary").click();
      await breaker.getByRole("button", { name: removeName, exact: true }).click();
      await expect(breaker).not.toHaveAttribute("open");
      await expect(breakerBadge).toHaveCount(0);
      await expect(canvasPolicies.getByRole("button", { name: ru ? "Заглушка" : "Fallback", exact: true })).toBeVisible();
      await expect(breaker).toContainText(ru ? "Удалена в этом варианте" : "Removed in this variant");
      await save();
      const first = await saved();
      expect(first.model.connections.find(edge => edge.id === "order-to-payment")!.params).toHaveProperty("circuitBreaker");
      expect(first.experiment.variants[1].overrides).toEqual({ "order-to-payment.circuitBreaker": null });
      expect(first.model.connections.find(edge => edge.id === "order-to-payment")!.params.fallback).toEqual({ on: ["circuitOpen", "timeout"], processing: "1ms" });
      await page.reload();
      await page.getByRole("tab", { name: withoutBreaker, exact: true }).click();
      await selectCall();
      await expect(breaker).toContainText(ru ? "Удалена в этом варианте" : "Removed in this variant");
      await expect(breakerBadge).toHaveCount(0);
      if (ru) {
        await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
        await breaker.scrollIntoViewIfNeeded();
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("policy-removed-ru.png") });
      }
      await run(1);

      await page.getByRole("tab", { name: ru ? "Модель" : "Model", exact: true }).click();
      await page.getByRole("tab", { name: withoutBreaker, exact: true }).click();
      await selectCall();
      await breaker.getByRole("button", { name: ru ? "Вернуть" : "Restore", exact: true }).click();
      await expect(breakerBadge).toBeVisible();
      const duration = breaker.getByRole("textbox", { name: ru ? "Время размыкания" : "Open duration", exact: true });
      await duration.fill("7s"); await duration.press("Enter");
      await page.getByRole("tab", { name: ru ? "Модель" : "Model", exact: true }).click();
      await page.getByRole("button", { name: ru ? "Настройки прогона" : "Run settings", exact: true }).click();
      await inspector.getByRole("button", { name: ru ? "Добавить ось сетки" : "Add grid axis", exact: true }).click();
      await inspector.getByRole("combobox", { name: ru ? "Параметр оси 1" : "Axis 1 parameter", exact: true }).selectOption("order-to-payment.circuitBreaker.openDuration");
      await inspector.getByRole("button", { name: ru ? "Добавить значение на ось 1" : "Add value to axis 1", exact: true }).click();
      await save();
      const beforeRemoval = await saved();
      const estimate = await page.request.post("/api/v1/estimate", { data: { experiment: experimentPath } });
      expect(estimate.ok()).toBe(true);
      expect((await estimate.json()).tasks).toBe(8);
      await run(2);

      await page.getByRole("tab", { name: ru ? "Модель" : "Model", exact: true }).click();
      await selectCall();
      await breaker.getByRole("button", { name: removeName, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: ru ? "Удалить зависимые настройки?" : "Remove dependent settings?" });
      await expect(dialog).toContainText(ru ? "Ось 1" : "Axis 1");
      await expect(dialog).toContainText(withoutBreaker);
      if (ru) {
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("policy-dependent-removal-ru.png") });
      }
      await dialog.getByRole("button", { name: ru ? "Отменить" : "Cancel", exact: true }).click();
      await expect(breaker).toBeVisible();
      await expect(page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true })).toBeDisabled();
      await breaker.getByRole("button", { name: removeName, exact: true }).click();
      await dialog.getByRole("button", { name: ru ? "Изменить" : "Change", exact: true }).click();
      await expect(breaker).toHaveCount(0);
      await save();
      const removed = await saved();
      expect(removed.experiment.grid).toEqual([]);
      expect(removed.experiment.variants[1].overrides).toEqual({});
      expect(removed.model.connections.find(edge => edge.id === "order-to-payment")!.params).not.toHaveProperty("circuitBreaker");
      await page.getByRole("button", { name: ru ? "Отменить действие" : "Undo", exact: true }).click();
      await save();
      expect(await saved()).toEqual(beforeRemoval);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("edits an imported policy sweep without a base policy, saves and estimates both variants", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "en"));
  const directory = `policy-axis-${randomUUID()}`;
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  await mkdir(root);
  try {
    const experiment = await copySmallExperiment(root);
    experiment.grid = [{ path: "gateway.rateLimit.burst", values: [5, 10] }];
    experiment.variants[1].overrides["gateway.rateLimit"] = { rate: "100/s", burst: 10 };
    await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
    const path = `${directory}/retry-storm.experiment.json`;
    await page.goto("/");
    await selectExperiment(page, path);
    await page.getByRole("button", { name: "Run settings", exact: true }).click();
    const first = page.getByRole("textbox", { name: "Axis 1 value 1", exact: true });
    await expect(first).toBeEditable();
    await first.fill("6"); await first.press("Enter");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeHidden();
    const saved = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(path)}`);
    expect((await saved.json()).content.experiment.grid).toEqual([{ path: "gateway.rateLimit.burst", values: [6, 10] }]);
    const estimate = await page.request.post("/api/v1/estimate", { data: { experiment: path } });
    expect(estimate.ok()).toBe(true);
    expect((await estimate.json()).tasks).toBe(8);
    await page.reload();
    await page.getByRole("button", { name: "Run settings", exact: true }).click();
    await expect(first).toHaveValue("6");
    await expect(first).toBeEditable();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
