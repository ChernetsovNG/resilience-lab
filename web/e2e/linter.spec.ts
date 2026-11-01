import { expect, selectExperiment, test } from "./fixtures";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile, ValidationReport } from "../src/api/apiTypes";

test.use({ locale: "ru-RU" });

test("routes replica load and groups equivalent warnings from the real API in Russian", async ({ page }, testInfo) => {
  const directory = `linter-${randomUUID()}`;
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  const labels = JSON.parse(await readFile(resolve("src/i18n/ru.json"), "utf8")) as Record<string, string>;
  const model: ModelFile = { schemaVersion: 6, blocks: {
    client: { type: "client", params: { load: { points: [{ time: "0s", rate: "900/s" }] }, deadline: "1s" } },
    catalog: { type: "service", params: { handlers: 16, replicas: 3, processing: { kind: "fixed", mean: "35ms" } } },
  }, connections: [{ id: "request", type: "request", from: "client", to: "catalog" }] };
  const experiment: ExperimentFile = { schemaVersion: 3, modelRef: "model.model.json",
    execution: { replications: 10, warmup: "0ms", measurement: "1s", seed: 42 },
    variants: [{ id: "baseline", label: "Базовый", overrides: {} }, { id: "pool", label: "Пул 16", overrides: {} }] };
  const save = async () => {
    await writeFile(resolve(root, "model.model.json"), JSON.stringify(model));
    await writeFile(resolve(root, "experiment.experiment.json"), JSON.stringify(experiment));
  };
  await mkdir(root, { recursive: true });
  try {
    await save();
    const response = await page.request.post("/api/v1/validate", { data: { experiment: `${directory}/experiment.experiment.json` } });
    expect(response.ok()).toBe(true);
    const report: ValidationReport = await response.json();
    expect(report.valid).toBe(true);
    expect(report.diagnostics).toEqual([]);

    model.blocks.client.params.load = { points: [{ time: "0s", rate: "1800/s" }] };
    for (const variant of experiment.variants) variant.overrides = { "catalog.handlers": 16 };
    await save();
    await page.goto("/");
    await selectExperiment(page, `${directory}/experiment.experiment.json`);
    await page.getByRole("tab", { name: labels["results.problems.title"], exact: true }).click();
    const tab = page.getByRole("tab", { name: labels["results.problems.title"], exact: true });
    await expect(tab).toHaveText("Проблемы (1)");
    const rows = page.locator(".validation-problems > li");
    await expect(rows).toHaveCount(1);
    const warning = rows.locator('button[data-diagnostic-code="LINT_HANDLERS_LITTLE"]');
    await expect(warning).toContainText("реплики #1–#3; варианты: Базовый, Пул 16");
    await expect(warning).not.toContainText(/LINT_|λ/);
    for (const [width, height] of [[1280, 800], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: testInfo.outputPath(`grouped-ru-${width}.png`) });
    }
    await rows.getByRole("button", { name: new RegExp(labels["results.problems.explanation"]) }).click();
    await expect(rows.getByRole("tooltip")).toContainText("λ·W / 1000");
    await expect(rows.getByRole("tooltip")).toContainText("LINT_HANDLERS_LITTLE");
    await page.screenshot({ path: testInfo.outputPath("help-ru.png") });
    await page.keyboard.press("Escape");
    await warning.click();
    await expect(page.getByRole("tab", { name: "Базовый", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".inspector").getByLabel(labels["catalog.types.service.params.handlers.title"], { exact: true })).toBeFocused();

    model.blocks.catalog.params.queue = 1000;
    await save();
    await page.reload();
    await selectExperiment(page, `${directory}/experiment.experiment.json`);
    await tab.click();
    await expect(tab).toHaveText("Проблемы (2)");
    const queueWarning = rows.locator('button[data-diagnostic-code="LINT_QUEUE_WAIT"]');
    await expect(queueWarning).toHaveCount(1);
    await expect(queueWarning).toContainText("реплики #1–#3; варианты: Базовый, Пул 16");
    await queueWarning.click();
    await expect(page.locator(".inspector").getByLabel(labels["catalog.types.service.params.queue.title"], { exact: true })).toBeFocused();
  } finally { await rm(root, { recursive: true, force: true }); }
});
