import { cleanupWorkspace, expect, selectExperiment, test } from "./fixtures";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile, ValidationReport } from "../src/api/apiTypes";

test.use({ locale: "ru-RU" });

test("routes replica load and groups equivalent warnings from the real API in Russian", async ({ page }, testInfo) => {
  const directory = `linter-${randomUUID()}`;
  const root = resolve("../apps/server/build/e2e-workspace", directory);
  const labels = JSON.parse(await readFile(resolve("src/i18n/ru.json"), "utf8")) as Record<string, string>;
  const model: ModelFile = { schemaVersion: 7, blocks: {
    client: { type: "client", params: { load: { points: [{ time: "0s", rate: "900/s" }] }, deadline: "1s" } },
    catalog: { type: "service", params: { handlers: 16, replicas: 3, queue: 1, processing: { kind: "fixed", mean: "35ms" } } },
  }, connections: [{ id: "request", type: "request", from: "client", to: "catalog" }] };
  const experiment: ExperimentFile = { schemaVersion: 4, modelRef: "model.model.json",
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
  } finally {
    await cleanupWorkspace(page, root);
  }
});

for (const [language, locale] of [["en", "en-US"], ["ru", "ru-RU"]] as const) {
  test.describe(`retry overload in ${language}`, () => {
    test.use({ locale });
    test("translates a shared retry budget and opens incoming attempts for grouped replicas", async ({ page }) => {
      const directory = `retry-overload-${randomUUID()}`;
      const root = resolve("../apps/server/build/e2e-workspace", directory);
      const labels = JSON.parse(await readFile(resolve(`src/i18n/${language}.json`), "utf8")) as Record<string, string>;
      const model: ModelFile = { schemaVersion: 7, blocks: {
        client: { type: "client", params: { load: { points: [{ time: "0s", rate: "900/s" }] }, deadline: "10s" } },
        gateway: { type: "service", params: { handlers: 100, processing: { kind: "fixed", mean: "1ms" } } },
        catalog: { type: "service", params: { handlers: 16, replicas: 3, processing: { kind: "fixed", mean: "35ms" } } },
      }, connections: [
        { id: "request", type: "request", from: "client", to: "gateway" },
        { id: "gateway-catalog", type: "call", from: "gateway", to: "catalog", params: {
          attempts: 3, timeout: "100ms", backoff: { kind: "exponential-full-jitter", base: "1ms", max: "10ms", multiplier: 2 },
          retryBudget: { ratio: "50%", minPerSecond: "150/s", window: "1s" },
        } },
      ] };
      const experiment: ExperimentFile = { schemaVersion: 4, modelRef: "model.model.json",
        execution: { replications: 10, warmup: "0ms", measurement: "1s", seed: 42 }, variants: [{ id: "baseline" }] };
      await mkdir(root, { recursive: true });
      try {
        await writeFile(resolve(root, "model.model.json"), JSON.stringify(model));
        await writeFile(resolve(root, "experiment.experiment.json"), JSON.stringify(experiment));
        await page.goto("/");
        await selectExperiment(page, `${directory}/experiment.experiment.json`);
        await page.getByRole("tab", { name: labels["results.problems.title"], exact: true }).click();
        const rows = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_RETRY_OVERLOAD"]') });
        const warning = rows.locator('button[data-diagnostic-code="LINT_RETRY_OVERLOAD"]');
        await expect(warning).toHaveCount(1);
        await expect(warning).toContainText("500");
        await expect(warning).toContainText("gateway-catalog");
        await expect(warning).toContainText(language === "ru" ? "Бюджет ограничил" : "Retry budgets limit");
        await expect(warning).toContainText("#1–#3");
        await rows.getByRole("button", { name: new RegExp(labels["results.problems.explanation"]) }).click();
        await expect(rows.getByRole("tooltip")).toContainText("ρ_max");
        await page.keyboard.press("Escape");
        await warning.click();
        await expect(page.locator(".inspector").getByLabel(labels["catalog.types.call.params.attempts.title"], { exact: true })).toBeFocused();
      } finally { await cleanupWorkspace(page, root); }
    });
  });
}

for (const [language, locale] of [["en", "en-US"], ["ru", "ru-RU"]] as const) {
  test.describe(`nominal headroom in ${language}`, () => {
    test.use({ locale });
    test("translates headroom and rejection risk and opens their fields for grouped replicas and variants", async ({ page }) => {
      const directory = `low-headroom-${randomUUID()}`;
      const root = resolve("../apps/server/build/e2e-workspace", directory);
      const labels = JSON.parse(await readFile(resolve(`src/i18n/${language}.json`), "utf8")) as Record<string, string>;
      const model: ModelFile = { schemaVersion: 7, blocks: {
        client: { type: "client", params: { load: { points: [{ time: "0s", rate: "1800/s" }] }, deadline: "1s" } },
        catalog: { type: "service", params: { handlers: 16, replicas: 3, processing: { kind: "fixed", mean: "35ms" },
          rateLimit: { rate: "400/s", burst: 1 } } },
      }, connections: [{ id: "request", type: "request", from: "client", to: "catalog" }] };
      const experiment: ExperimentFile = { schemaVersion: 4, modelRef: "model.model.json",
        execution: { replications: 10, warmup: "0ms", measurement: "1s", seed: 42 },
        variants: ["Base", "Equivalent"].map((label, index) => ({ id: `v${index}`, label, overrides: { "catalog.handlers": 16, "catalog.queue": 0 } })) };
      await mkdir(root, { recursive: true });
      try {
        await writeFile(resolve(root, "model.model.json"), JSON.stringify(model));
        await writeFile(resolve(root, "experiment.experiment.json"), JSON.stringify(experiment));
        const response = await page.request.post("/api/v1/validate", { data: { experiment: `${directory}/experiment.experiment.json` } });
        expect(response.ok()).toBe(true);
        const report: ValidationReport = await response.json();
        expect(report.valid).toBe(true);
        const findings = report.diagnostics.filter(diagnostic => diagnostic.code === "LINT_LOW_HEADROOM");
        expect(findings).toHaveLength(6);
        expect(findings.every(diagnostic => diagnostic.severity === "WARNING" && diagnostic.args?.utilization === "0.875")).toBe(true);
        const rejections = report.diagnostics.filter(diagnostic => diagnostic.code === "LINT_REJECTION_RISK");
        expect(rejections).toHaveLength(6);
        expect(rejections.every(diagnostic => diagnostic.severity === "WARNING" && diagnostic.args?.ratePerSecond === "400"
          && diagnostic.pointer === `/variants/${diagnostic.variant === "v0" ? 0 : 1}/overrides/catalog.queue`)).toBe(true);

        await page.goto("/");
        await selectExperiment(page, `${directory}/experiment.experiment.json`);
        await page.getByRole("tab", { name: labels["results.problems.title"], exact: true }).click();
        const rows = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_LOW_HEADROOM"]') });
        const warning = rows.locator('button[data-diagnostic-code="LINT_LOW_HEADROOM"]');
        await expect(warning).toHaveCount(1);
        await expect(warning).toContainText(language === "ru" ? "Малый запас ёмкости" : "Little spare capacity");
        await expect(warning).toContainText(`${labels["catalog.types.service.params.rateLimit.title"].toLowerCase()}${language === "ru" ? " " : ": "}400`);
        await expect(warning).toContainText("#1–#3");
        await expect(warning).toContainText("Base, Equivalent");
        await rows.getByRole("button", { name: new RegExp(labels["results.problems.explanation"]) }).click();
        await expect(rows.getByRole("tooltip")).toContainText("ρ = λ × W / handlers");
        await expect(rows.getByRole("tooltip")).toContainText("LINT_LOW_HEADROOM");
        await page.keyboard.press("Escape");
        await warning.click();
        await expect(page.getByRole("tab", { name: "Base", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(page.locator(".inspector").getByLabel(labels["catalog.types.service.params.handlers.title"], { exact: true })).toBeFocused();

        const rejectionRows = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_REJECTION_RISK"]') });
        const rejection = rejectionRows.locator('button[data-diagnostic-code="LINT_REJECTION_RISK"]');
        await expect(rejection).toHaveCount(1);
        await expect(rejection).toContainText(language === "ru" ? "расчётная доля отказов" : "estimated rejections");
        await expect(rejection).toContainText("400");
        await expect(rejection).toContainText("#1–#3");
        await expect(rejection).toContainText("Base, Equivalent");
        await rejectionRows.getByRole("button", { name: new RegExp(labels["results.problems.explanation"]) }).click();
        await expect(rejectionRows.getByRole("tooltip")).toContainText(language === "ru" ? "Эрланг B" : "Erlang B");
        await expect(rejectionRows.getByRole("tooltip")).toContainText("LINT_REJECTION_RISK");
        await page.keyboard.press("Escape");
        await rejection.click();
        await expect(page.locator(".inspector").getByLabel(labels["catalog.types.service.params.queue.title"], { exact: true })).toBeFocused();
        await expect(page.getByRole("button", { name: labels["app.topBar.run"], exact: true })).toBeEnabled();
      } finally {
        await cleanupWorkspace(page, root);
      }
    });
  });
}
