import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunSummary } from "../src/api/apiTypes";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`edits, persists and runs a load ramp with a whole-profile variant override in ${language}`, async ({ page }, testInfo) => {
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const ru = language === "ru";
    const directory = `load-profile-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const experiment = await copySmallExperiment(root);
      experiment.execution = { ...experiment.execution, warmup: "5s", measurement: "25s", window: "1s" };
      experiment.variants = experiment.variants.filter(variant => variant.id === "baseline");
      experiment.faults = [];
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
      const section = page.locator(".inspector-load");
      const table = section.getByRole("table", { name: ru ? "Точки нагрузки" : "Load points" });
      const rows = table.locator("tbody tr");
      const time = ru ? "Время" : "Time";
      const rate = ru ? "Интенсивность" : "Intensity";
      const canvas = page.getByRole("application", { name: ru ? "Полотно модели" : "Model canvas", exact: true });
      const before = await canvas.boundingBox();
      await rows.first().getByRole("textbox", { name: rate, exact: true }).fill("10/s");
      await rows.first().getByRole("textbox", { name: rate, exact: true }).press("Enter");
      await section.getByRole("button", { name: ru ? "Добавить точку" : "Add point", exact: true }).click();
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).fill("30s");
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).press("Enter");
      await rows.nth(1).getByRole("textbox", { name: rate, exact: true }).fill("100/s");
      await rows.nth(1).getByRole("textbox", { name: rate, exact: true }).press("Enter");
      const course = page.getByRole("region", { name: ru ? "Ход эксперимента" : "Experiment course", exact: true });
      await expect(course).toContainText(ru ? "от 10 RPS до 100 RPS" : "from 10 RPS to 100 RPS");
      await course.getByRole("button", { name: ru ? "Ход эксперимента" : "Experiment course", exact: true }).click();
      await expect(course.locator("polyline")).toHaveAttribute("points", "0,60 1000,24");
      const after = await canvas.boundingBox();
      expect({ width: after!.width, height: after!.height }).toEqual({ width: before!.width, height: before!.height });
      const dimensions = JSON.stringify({ before, after });
      await writeFile(testInfo.outputPath("canvas-size.json"), dimensions);
      await testInfo.attach("canvas-size", { body: dimensions, contentType: "application/json" });
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).fill("0s");
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).press("Enter");
      await expect(rows.nth(1).locator(".diagnostic-code")).toContainText("LOAD_POINT_ORDER");
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).fill("30s");
      await rows.nth(1).getByRole("textbox", { name: time, exact: true }).press("Enter");
      await expect(page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: ru ? "Свернуть результаты" : "Collapse results", exact: true }).click();
      const save = page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true });
      await save.click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      const modelURL = `/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.model.json`)}`;
      const ramp = { points: [{ time: "0s", rate: "10/s" }, { time: "30s", rate: "100/s" }] };
      expect((await (await page.request.get(modelURL)).json()).content.model.blocks.client.params.load).toEqual(ramp);
      await page.reload();
      await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
      await expect(rows.nth(1).getByRole("textbox", { name: rate, exact: true })).toHaveValue("100/s");
      const run = page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true });
      await expect(run).toBeEnabled();
      await page.mouse.move(700, 100);
      if (ru) await page.screenshot({ path: testInfo.outputPath("load-profile-ru.png") });
      const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await run.click();
      const summary: RunSummary = await (await response).json();
      await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
      const arrivals = summary.variants[0].points[0].aggregate.services.gateway.totals.originalArrivals;
      // The measurement-cohort integral is 2 * 25s * (25 + 100) / 2 = 3125 arrivals.
      // Both a constant 10/s and a constant 100/s fall outside this broad Poisson tolerance.
      expect(arrivals).toBeGreaterThan(2500);
      expect(arrivals).toBeLessThan(3800);
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
      await rows.nth(1).getByRole("textbox", { name: rate, exact: true }).fill("120/s");
      await rows.nth(1).getByRole("textbox", { name: rate, exact: true }).press("Enter");
      await expect(course).toContainText(ru ? "от 10 RPS до 120 RPS" : "from 10 RPS to 120 RPS");
      const variantTime = rows.nth(1).getByRole("textbox", { name: time, exact: true });
      await variantTime.fill("0s");
      await variantTime.press("Enter");
      await expect(rows.nth(1).locator(".diagnostic-code")).toContainText("LOAD_POINT_ORDER");
      await expect(variantTime).toHaveAttribute("aria-invalid", "true");
      await variantTime.fill("30s");
      await variantTime.press("Enter");
      await expect(run).toBeEnabled();
      await save.click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      const experimentURL = `/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.experiment.json`)}`;
      const saved = (await (await page.request.get(experimentURL)).json()).content.experiment;
      expect(saved.variants[0].overrides["client.load"]).toEqual({ points: [ramp.points[0], { time: "30s", rate: "120/s" }] });
      expect(Object.keys(saved.variants[0].overrides).filter(path => path.startsWith("client.load"))).toEqual(["client.load"]);
      expect((await (await page.request.get(modelURL)).json()).content.model.blocks.client.params.load).toEqual(ramp);
      await page.reload();
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await page.getByTestId("rf__node-client").locator(".block-node > strong").click();
      await expect(rows.nth(1).getByRole("textbox", { name: rate, exact: true })).toHaveValue("120/s");
      await expect(run).toBeEnabled();
      await page.mouse.move(700, 100);
      if (ru) await page.screenshot({ path: testInfo.outputPath("load-profile-variant-ru.png") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
