import { expect, test, removeWorkspacePath } from "./fixtures";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile, RunSummary } from "../src/api/apiTypes";
import { copySmallExperiment, selectExperiment } from "./fixtures";

test.use({ viewport: { width: 1920, height: 1100 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`edits a repeated service scenario, persists it and runs it in ${language}`, async ({ page }, testInfo) => {
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const ru = language === "ru";
    const directory = `service-scenario-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root);
      experiment.faults = [];
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      const modelPath = `${directory}/retry-storm.model.json`;
      const source: ModelFile = JSON.parse(await readFile(resolve(root, "retry-storm.model.json"), "utf8"));
      source.connections.push({ ...source.connections.find(edge => edge.id === "gateway-to-middle")!,
        id: "gateway-to-dependency", from: "gateway", to: "dependency" });
      await writeFile(resolve(root, "retry-storm.model.json"), JSON.stringify(source));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      const canvas = page.getByLabel(ru ? "Полотно модели" : "Model canvas", { exact: true });
      await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector" });
      await inspector.locator(".inspector-parameters > summary").click();
      const section = inspector.locator(".inspector-scenario");
      await section.getByRole("button", { name: ru ? "Задать свой сценарий" : "Set custom scenario", exact: true }).click();
      const before = await canvas.boundingBox();
      const steps = section.locator(".scenario-step");
      const connection = ru ? "Связь" : "Connection";
      await steps.nth(1).getByRole("combobox", { name: connection, exact: true }).selectOption("gateway-to-middle");
      await steps.nth(2).getByRole("combobox", { name: connection, exact: true }).selectOption("gateway-to-dependency");
      await section.getByRole("button", { name: ru ? "Добавить вызов" : "Add call", exact: true }).click();
      await steps.nth(3).getByRole("combobox", { name: connection, exact: true }).selectOption("gateway-to-middle");
      await expect(steps).toHaveCount(4);
      const expected = [
        { type: "process", connection: null, processing: null, failureRate: null, classes: null },
        { type: "call", connection: "gateway-to-middle", processing: null, failureRate: null, classes: null },
        { type: "call", connection: "gateway-to-dependency", processing: null, failureRate: null, classes: null },
        { type: "call", connection: "gateway-to-middle", processing: null, failureRate: null, classes: null },
      ];
      const after = await canvas.boundingBox();
      expect({ width: after!.width, height: after!.height }).toEqual({ width: before!.width, height: before!.height });
      await testInfo.attach("canvas-size", { body: JSON.stringify({ before, after }), contentType: "application/json" });
      const save = page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true });
      await save.click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      const stored = await page.request.get(`/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`);
      expect((await stored.json()).content.model.blocks.gateway.scenario).toEqual(expected);
      await page.reload();
      await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
      await expect(steps).toHaveCount(4);
      await expect(steps.nth(3).getByRole("combobox", { name: connection, exact: true })).toHaveValue("gateway-to-middle");
      const run = page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true });
      await expect(run).toBeEnabled();
      await page.mouse.move(800, 100);
      if (ru) await page.screenshot({ path: testInfo.outputPath("service-scenario-ru.png") });
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
      await expect(steps.nth(1).getByRole("combobox", { name: connection, exact: true })).toBeDisabled();
      await page.mouse.move(800, 100);
      if (ru) await page.screenshot({ path: testInfo.outputPath("service-scenario-variant-ru.png") });
      const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await run.click();
      const summary: RunSummary = await (await response).json();
      await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
      const calls = summary.variants[0].points[0].aggregate.connections;
      expect(calls["gateway-to-dependency"].totals.sentAttempts).toBeGreaterThan(0);
      expect(calls["gateway-to-middle"].totals.sentAttempts).toBeGreaterThan(calls["gateway-to-dependency"].totals.sentAttempts);
    } finally {
      await removeWorkspacePath(page, root);
    }
  });
}
