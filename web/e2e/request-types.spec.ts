import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile, RunSummary } from "../src/api/apiTypes";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`edits, persists and runs request types; deletion keeps invalid references and Undo restores them in ${language}`, async ({ page }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `request-types-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root);
      experiment.execution = { ...experiment.execution, warmup: "0s", measurement: "60s", window: "1s" };
      experiment.variants = experiment.variants.filter(variant => variant.id === "baseline");
      experiment.faults = [];
      const model: ModelFile = JSON.parse(await readFile(resolve(root, "retry-storm.model.json"), "utf8"));
      model.blocks["mobile-app"] = model.blocks.client;
      delete model.blocks.client;
      model.blocks["mobile-app"].params.load = { points: [{ time: "0s", rate: "20/s" }] };
      model.connections.find(connection => connection.type === "request")!.from = "mobile-app";
      model.blocks.gateway.scenario = [
        { type: "process" }, { type: "call", connection: "gateway-to-middle", classes: ["checkout"] },
      ];
      model.blocks.router = { type: "router", params: { policy: "roundRobin" } };
      model.connections.find(connection => connection.id === "middle-to-dependency")!.to = "router";
      model.connections.push({ id: "checkout-route", type: "route", from: "router", to: "dependency", params: {}, classes: ["checkout"] });
      await writeFile(resolve(root, "retry-storm.model.json"), JSON.stringify(model));
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      await writeFile(resolve(root, "sibling.experiment.json"), JSON.stringify({ ...experiment, variants: [{ id: "baseline", overrides: {
        "mobile-app.load": null, "mobile-app.classes": [{ id: "checkout", load: { points: [{ time: "0s", rate: "10/s" }] } }],
      } }] }));
      const layoutPath = resolve(root, "retry-storm.layout.json");
      const layout = JSON.parse(await readFile(layoutPath, "utf8"));
      layout.positions["mobile-app"] = layout.positions.client;
      delete layout.positions.client;
      await writeFile(layoutPath, JSON.stringify(layout));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      const modelURL = `/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.model.json`)}`;
      const expected: ModelFile = (await (await page.request.get(modelURL)).json()).content.model;
      const client = page.getByTestId("rf__node-mobile-app");
      await client.locator(".block-node > strong").click();
      await page.getByRole("radio", { name: ru ? "Несколько видов запросов" : "Several request types", exact: true }).check();
      const ids = page.getByRole("textbox", { name: ru ? "Идентификатор вида запроса" : "Request type ID", exact: true });
      await expect(ids).toHaveCount(1);
      await expect(ids.first()).toHaveValue("request-1");
      await ids.first().fill("status");
      await ids.first().press("Enter");
      await page.getByRole("button", { name: ru ? "Добавить вид запроса" : "Add request type", exact: true }).click();
      await ids.nth(1).fill("checkout");
      await ids.nth(1).press("Enter");
      const checkout = page.getByRole("group", { name: "checkout", exact: true });
      const rows = checkout.getByRole("table", { name: ru ? "Точки нагрузки" : "Load points" }).locator("tbody tr");
      const addPoint = checkout.getByRole("button", { name: ru ? "Добавить точку" : "Add point", exact: true });
      const time = ru ? "Время" : "Time", rate = ru ? "Интенсивность" : "Intensity";
      await addPoint.click();
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).fill("30s");
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).press("Enter");
      await rows.nth(1).getByRole("textbox", { name: rate, exact: true }).fill("60/s");
      await rows.nth(1).getByRole("textbox", { name: rate, exact: true }).press("Enter");
      await addPoint.click();
      await rows.nth(2).getByRole("textbox", { name: time, exact: true }).fill("60s");
      await rows.nth(2).getByRole("textbox", { name: time, exact: true }).press("Enter");
      await rows.nth(2).getByRole("textbox", { name: rate, exact: true }).fill("20/s");
      await rows.nth(2).getByRole("textbox", { name: rate, exact: true }).press("Enter");
      await expect(client).toContainText(ru ? "видов запросов: 2" : "request types: 2");
      await expect(client.locator(".request-type-summary")).toContainText("40 RPS");
      const course = page.getByRole("region", { name: ru ? "Ход эксперимента" : "Experiment course", exact: true });
      await course.getByRole("button", { name: ru ? "Ход эксперимента" : "Experiment course", exact: true }).click();
      await expect(course.locator(".course-load")).toHaveCount(3);
      await expect(course.locator("figcaption")).toHaveText(["mobile-app · status", "mobile-app · checkout", ru ? "mobile-app · сумма" : "mobile-app · total"]);
      await expect(course.locator("polyline").last()).toHaveAttribute("points", "0,44 500,24 1000,44");
      const save = page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true });
      await save.click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      delete expected.blocks["mobile-app"].params.load;
      const types = [
        { id: "status", load: { points: [{ time: "0s", rate: "20/s" }] } },
        { id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }, { time: "30s", rate: "60/s" }, { time: "60s", rate: "20/s" }] } },
      ];
      expected.blocks["mobile-app"].params.classes = types;
      expect((await (await page.request.get(modelURL)).json()).content.model).toEqual(expected);
      await page.reload();
      await client.locator(".block-node > strong").click();
      await expect(ids.nth(1)).toHaveValue("checkout");
      const run = page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true });
      await expect(run).toBeEnabled();
      if (ru) {
        const parameters = page.locator(".inspector-parameters");
        if (await parameters.getAttribute("open") !== null) await parameters.locator("summary").click();
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("request-types-ru.png") });
      }
      const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await run.click();
      const summary: RunSummary = await (await response).json();
      await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
      const entries = summary.variants[0].points[0].aggregate.entries;
      expect(Object.keys(entries.classes).sort()).toEqual(["checkout", "status"]);

      await page.getByRole("tab", { name: ru ? "Модель" : "Model", exact: true }).click();
      await client.locator(".block-node > strong").click();
      await page.getByRole("button", { name: ru ? "Удалить checkout" : "Delete checkout", exact: true }).click();
      await page.getByRole("region", { name: ru ? "Строка состояния" : "Status bar", exact: true })
        .getByRole("button", { name: ru ? /^Ошибок: 2\b/ : /^Errors: 2\b/ }).click();
      const problems = page.getByRole("tabpanel", { name: ru ? "Проблемы" : "Problems", exact: true });
      await expect(problems.getByRole("button", { name: /CLASS_UNKNOWN/ })).toHaveCount(2);
      await expect(problems.getByRole("button", { name: /gateway CLASS_UNKNOWN/ })).toBeVisible();
      await expect(problems.getByRole("button", { name: /checkout-route.*CLASS_UNKNOWN/ })).toBeVisible();
      if (ru) await page.screenshot({ path: testInfo.outputPath("request-types-problems-ru.png") });
      await page.getByRole("button", { name: ru ? "Отменить действие" : "Undo", exact: true }).click();
      await expect(ids.nth(1)).toHaveValue("checkout");
      await expect(run).toBeEnabled();
      await expect(save).toBeDisabled();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      expect((await (await page.request.get(modelURL)).json()).content.model).toEqual(expected);
      await expect(checkout.locator(".inspector-type")).toContainText("sibling");
      await ids.nth(1).fill("purchase");
      await ids.nth(1).press("Enter");
      await expect(run).toBeEnabled();
      await save.click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      const siblingPath = `${directory}/sibling.experiment.json`;
      const siblingURL = `/api/v1/workspace/document?path=${encodeURIComponent(siblingPath)}`;
      const sibling = (await (await page.request.get(siblingURL)).json()).content.experiment;
      expect(sibling.variants[0].overrides["mobile-app.classes"][0].id).toBe("purchase");
      const valid = await page.request.post("/api/v1/validate", { data: { experiment: siblingPath } });
      expect((await valid.json()).valid).toBe(true);
      await page.getByRole("button", { name: ru ? "Отменить действие" : "Undo", exact: true }).click();
      await save.click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      expect((await (await page.request.get(modelURL)).json()).content.model).toEqual(expected);
      expect((await (await page.request.get(siblingURL)).json()).content.experiment.variants[0].overrides["mobile-app.classes"][0].id).toBe("checkout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
