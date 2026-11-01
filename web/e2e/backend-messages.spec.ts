import { cleanupWorkspace, expect, test } from "./fixtures";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { ExperimentFile, ModelFile, ValidationReport } from "../src/api/apiTypes";
import { resolve } from "node:path";
import { selectExperiment } from "./fixtures";

// Exercise every supported language; #184 adds ru.json and the browser-language selection.
const locales = ["en-US", ...(existsSync(resolve("src/i18n/ru.json")) ? ["ru-RU"] : [])];

for (const locale of locales) {
  test.describe(`backend messages (${locale})`, () => {
    test.use({ locale });
    const catalog = JSON.parse(readFileSync(resolve(`src/i18n/${locale.startsWith("ru") ? "ru" : "en"}.json`), "utf8")) as Record<string, string>;
    const label = (key: string) => catalog[key];

    for (const [target, capacity, waitMs, limitMs, source] of [
      ["gateway", "80", "260", "250", "client"],
      ["dependency", "20", "80", "60", "middle-to-dependency"],
    ]) {
      test(`localizes full queue patience for ${target} and opens the affected queue`, async ({ page }) => {
        await page.goto("/");
        await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
        await page.getByTestId(`rf__node-${target}`).click();
        const queue = page.getByLabel(label("catalog.types.service.params.queue.title"), { exact: true });
        await queue.fill(capacity);
        await queue.press("Enter");
        await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
        const warning = page.getByRole("tabpanel").locator('button[data-diagnostic-code="LINT_QUEUE_WAIT"]');

        await expect(warning).toBeVisible();
        await expect(warning).toContainText(locale.startsWith("ru") ? `ожидание ${waitMs} мс` : `wait ${waitMs} ms`);
        await expect(warning).toContainText(`${limitMs} ${locale.startsWith("ru") ? "мс" : "ms"}`);
        await expect(warning).toContainText(source);
        await warning.click();
        await expect(queue).toBeFocused();
        await expect(queue.locator("..").locator(".field-diagnostics")).toContainText("LINT_QUEUE_WAIT");
        await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
      });
    }

    for (const kind of ["call", "pooler"] as const) {
      test(`localizes ${kind} pool demand from the API and opens the overridden capacity`, async ({ page }) => {
        const directory = `pool-demand-${randomUUID()}`;
        const root = resolve("../apps/server/build/e2e-workspace", directory);
        const target = kind === "call" ? "caller-db" : "proxy";
        const parameter = kind === "call" ? "caller-db.pool.size" : "proxy.poolSize";
        const model: ModelFile = { schemaVersion: 7, blocks: {
          client: { type: "client", params: { load: { points: [{ time: "0s", rate: "100/s" }] }, deadline: "10s" } },
          caller: { type: "service", params: { handlers: 8, queue: 16, processing: { kind: "fixed", mean: "0ms" } } },
          db: { type: "database", params: { maxConnections: 100, processing: { kind: "fixed", mean: "40ms" } } },
          ...(kind === "pooler" ? { proxy: { type: "pooler", params: { maxClientConnections: 100, poolSize: 4, waitTimeout: "1s" } } } : {}),
        }, connections: [
          { id: "request", type: "request", from: "client", to: "caller" },
          { id: "caller-db", type: "call", from: "caller", to: kind === "call" ? "db" : "proxy", params: {
            timeout: "1s", network: { kind: "fixed", mean: "0ms" }, ...(kind === "call" ? { pool: { size: 4 } } : {}),
          } },
          ...(kind === "pooler" ? [{ id: "proxy-db", type: "call", from: "proxy", to: "db", params: {
            timeout: "1s", network: { kind: "fixed", mean: "0ms" },
          } }] : []),
        ] };
        const experiment: ExperimentFile = { schemaVersion: 4, modelRef: "model.model.json",
          execution: { replications: 5, warmup: "0ms", measurement: "1s", seed: 42 },
          variants: [{ id: "roomy", overrides: { [parameter]: 8 } }, { id: "tight", overrides: { [parameter]: 4 } }] };
        await mkdir(root, { recursive: true });
        try {
          await writeFile(resolve(root, "model.model.json"), JSON.stringify(model));
          await writeFile(resolve(root, "experiment.experiment.json"), JSON.stringify(experiment));
          const response = await page.request.post("/api/v1/validate", { data: { experiment: `${directory}/experiment.experiment.json` } });
          expect(response.ok()).toBe(true);
          const report: ValidationReport = await response.json();
          expect(report.valid).toBe(true);
          const findings = report.diagnostics.filter(diagnostic => diagnostic.code === "LINT_POOL_DEMAND");
          expect(findings).toHaveLength(1);
          const finding = findings[0];
          expect(finding.variant).toBe("tight");
          expect(finding.pointer).toBe(`/variants/1/overrides/${parameter}`);
          expect(finding.args).toMatchObject({ demand: "4", size: 4, ratePerSecond: "100", target });

          await page.goto("/");
          await selectExperiment(page, `${directory}/experiment.experiment.json`);
          await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
          const row = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_POOL_DEMAND"]') });
          const warning = row.locator('button[data-diagnostic-code="LINT_POOL_DEMAND"]');
          const key = `messages.LINT_POOL_DEMAND${kind === "call" ? ".limitsHandlers" : ""}`;
          const translated = label(key).split("{target}")[1].replace(/\{(\w+)\}/g, (_, name: string) => String(finding.args?.[name]));
          await expect(warning).toContainText(target);
          await expect(warning).toContainText(translated);
          await row.getByRole("button", { name: new RegExp(label("results.problems.explanation")) }).click();
          await expect(row.getByRole("tooltip")).toContainText(label("messages.LINT_POOL_DEMAND_DETAILS").split(":")[0]);
          await page.keyboard.press("Escape");
          await warning.click();
          const capacity = page.locator(".inspector").getByLabel(label(kind === "call"
            ? "catalog.types.call.params.pool.size.title" : "catalog.types.pooler.params.poolSize.title"), { exact: true });
          await expect(capacity).toBeFocused();
          await expect(capacity).toHaveValue("4");
          await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
        } finally {
          await cleanupWorkspace(page, root);
        }
      });
    }

    test("localizes health-check cascade and opens the overridden probe threshold", async ({ page }) => {
      const directory = `healthcheck-cascade-${randomUUID()}`;
      const root = resolve("../apps/server/build/e2e-workspace", directory);
      const parameter = "worker.healthCheck.unhealthyThreshold";
      const model: ModelFile = { schemaVersion: 7, blocks: {
        client: { type: "client", params: { load: { points: [{ time: "0s", rate: "200/s" }] }, deadline: "10s" } },
        gateway: { type: "service", params: { handlers: 100, processing: { kind: "fixed", mean: "0ms" } } },
        worker: { type: "service", params: { replicas: 3, handlers: 2, queue: 100,
          processing: { kind: "fixed", mean: "20ms" }, healthCheck: { interval: "100ms" } } },
      }, connections: [
        { id: "request", type: "request", from: "client", to: "gateway" },
        { id: "gateway-worker", type: "call", from: "gateway", to: "worker", params: { timeout: "1s" } },
      ] };
      const experiment: ExperimentFile = { schemaVersion: 4, modelRef: "model.model.json",
        execution: { replications: 5, warmup: "0ms", measurement: "1s", seed: 42 },
        variants: [{ id: "roomy", overrides: { "worker.handlers": 4 } }, { id: "tight", overrides: { [parameter]: 2 } }] };
      await mkdir(root, { recursive: true });
      try {
        await writeFile(resolve(root, "model.model.json"), JSON.stringify(model));
        await writeFile(resolve(root, "experiment.experiment.json"), JSON.stringify(experiment));
        const response = await page.request.post("/api/v1/validate", { data: { experiment: `${directory}/experiment.experiment.json` } });
        expect(response.ok()).toBe(true);
        const report: ValidationReport = await response.json();
        expect(report.valid).toBe(true);
        const findings = report.diagnostics.filter(diagnostic => diagnostic.code === "LINT_HEALTHCHECK_CASCADE");
        expect(findings).toHaveLength(3);
        for (const finding of findings) {
          expect(finding.variant).toBe("tight");
          expect(finding.pointer).toBe(`/variants/1/overrides/${parameter}`);
          expect(finding.args).toMatchObject({ replicas: 3, utilization: "0.667", remainingUtilization: "1" });
        }

        await page.goto("/");
        await selectExperiment(page, `${directory}/experiment.experiment.json`);
        await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
        const row = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_HEALTHCHECK_CASCADE"]') });
        const warning = row.locator('button[data-diagnostic-code="LINT_HEALTHCHECK_CASCADE"]');
        await expect(warning).toHaveCount(1);
        const translated = label("messages.LINT_HEALTHCHECK_CASCADE").split("{target}")[1]
          .replace(/\{(\w+)\}/g, (_, name: string) => String(findings[0].args?.[name]));
        await expect(warning).toContainText(translated);
        await row.getByRole("button", { name: new RegExp(label("results.problems.explanation")) }).click();
        await expect(row.getByRole("tooltip")).toContainText(label("messages.LINT_HEALTHCHECK_CASCADE_DETAILS").split(";")[0]);
        await page.keyboard.press("Escape");
        await warning.click();
        const threshold = page.locator(".inspector").getByLabel(label("catalog.types.service.params.healthCheck.unhealthyThreshold.title"), { exact: true });
        await expect(threshold).toBeFocused();
        await expect(threshold).toHaveValue("2");
        await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
      } finally {
        await cleanupWorkspace(page, root);
      }
    });

    test("localizes same-target retries and clears the edited variant after choosing other", async ({ page }) => {
      const example = JSON.parse(readFileSync(resolve("../examples/checkout-replicas/checkout-replicas.experiment.json"), "utf8")) as ExperimentFile;
      const baseline = example.variants.find(variant => variant.id === "baseline")!;
      const baselineLabel = baseline.label ?? baseline.id;
      await page.goto("/");
      await selectExperiment(page, "checkout-replicas/checkout-replicas.experiment.json");
      await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
      const row = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_RETRY_SAME_TARGET"]') });
      const warning = row.locator('button[data-diagnostic-code="LINT_RETRY_SAME_TARGET"]');
      const args: Record<string, string> = { connection: "api-gateway-to-order-service", attempts: "3", targets: "3", requestType: "default", threshold: "2" };
      const translated = label("messages.LINT_RETRY_SAME_TARGET").split("{connection}")[1]
        .replace(/\{(\w+)\}/g, (_, name: string) => args[name]);
      await expect(warning).toHaveCount(1);
      await expect(warning).toContainText(args.connection);
      await expect(warning).toContainText(translated);
      await expect(warning).toContainText(baselineLabel);
      await row.getByRole("button", { name: new RegExp(label("results.problems.explanation")) }).click();
      await expect(row.getByRole("tooltip")).toContainText(label("messages.LINT_RETRY_SAME_TARGET_DETAILS"));
      await page.keyboard.press("Escape");
      await warning.click();
      const target = page.locator(".inspector").getByLabel(label("catalog.types.call.params.retryTarget.title"), { exact: true });
      await expect(target).toBeFocused();
      await expect(target).toHaveValue("any");
      await target.selectOption("other");
      await expect(warning).not.toContainText(baselineLabel);
      await expect(warning).toContainText(translated);
      await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
    });

    test("localizes unguarded retries and clears the finding after reducing attempts", async ({ page }) => {
      const experiment = "retry-storm/retry-storm.experiment.json";
      const response = await page.request.post("/api/v1/validate", { data: { experiment } });
      expect(response.ok()).toBe(true);
      const report: ValidationReport = await response.json();
      expect(report.valid).toBe(true);
      const finding = report.diagnostics.find(diagnostic => diagnostic.code === "LINT_RETRY_UNGUARDED"
        && diagnostic.path === "gateway-to-middle")!;
      expect(finding.severity).toBe("WARNING");
      expect(finding.args).toMatchObject({ attempts: 3, amplification: 3 });
      const translated = label("messages.LINT_RETRY_UNGUARDED").split("{connection}")[1]
        .replace(/\{(\w+)\}/g, (_, name: string) => String(finding.args?.[name]));

      await page.goto("/");
      await selectExperiment(page, experiment);
      await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
      const row = page.locator(".validation-problems > li").filter({ has: page.locator('[data-diagnostic-code="LINT_RETRY_UNGUARDED"]') })
        .filter({ hasText: "gateway-to-middle" });
      const warning = row.locator('button[data-diagnostic-code="LINT_RETRY_UNGUARDED"]');
      await expect(warning).toContainText("gateway-to-middle");
      await expect(warning).toContainText(translated);
      await row.getByRole("button", { name: new RegExp(label("results.problems.explanation")) }).click();
      await expect(row.getByRole("tooltip")).toContainText(label("messages.LINT_RETRY_UNGUARDED_DETAILS"));
      await page.keyboard.press("Escape");
      await warning.click();
      const attempts = page.locator(".inspector").getByLabel(label("catalog.types.call.params.attempts.title"), { exact: true });
      await expect(attempts).toBeFocused();
      await expect(attempts).toHaveValue("3");
      await attempts.fill("1");
      await attempts.press("Enter");
      await expect(warning).toHaveCount(0);
      await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
    });

    test("localizes retries without jitter and opens the backoff parameter", async ({ page }) => {
      await page.goto("/");
      await selectExperiment(page, "checkout/checkout.experiment.json");
      await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
      const warning = page.getByRole("tabpanel").locator('button[data-diagnostic-code="LINT_RETRY_NO_JITTER"]');

      await expect(warning).toBeVisible();
      await expect(warning).toContainText("order-service-to-payment-service");
      await expect(warning).toContainText(locale.startsWith("ru") ? "3 попыток" : "3 attempts");
      await expect(warning).toContainText(label("catalog.options.exponential-full-jitter"));
      await warning.click();
      const kind = page.locator(".inspector").getByLabel(label("catalog.types.call.params.backoff.kind.title"), { exact: true });
      await expect(kind).toBeFocused();
      await expect(kind).toHaveValue("fixed");
      await expect(kind.locator("..").locator(".field-diagnostics")).toContainText("LINT_RETRY_NO_JITTER");
      await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
    });

    for (const [timeoutMs, estimatedMs] of [["500", "845"], ["845", "845.2"]]) {
      test(`localizes the normal latency estimate for timeout ${timeoutMs} ms and opens the affected timeout`, async ({ page }) => {
        await page.goto("/");
        await selectExperiment(page, "checkout/checkout.experiment.json");
        await page.getByTestId("canvas-edge-label-payment-service-to-psp").click();
        const timeout = page.getByLabel(label("catalog.types.call.params.timeout.title"), { exact: true });
        await timeout.fill(`${timeoutMs}ms`);
        await timeout.press("Enter");
        await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
        const warning = page.getByRole("tabpanel").locator('button[data-diagnostic-code="LINT_TIMEOUT_BELOW_LATENCY"]');

        await expect(warning).toBeVisible();
        await expect(warning).toContainText(locale.startsWith("ru") ? `Таймаут ${timeoutMs} мс` : `Timeout ${timeoutMs} ms`);
        await expect(warning).toContainText(locale.startsWith("ru") ? `: ${estimatedMs} мс` : `response ${estimatedMs} ms`);
        await expect(warning).toContainText("psp");
        await expect(warning).toContainText("p99");
        await expect(warning).toContainText("q=0.99");
        await warning.click();
        await expect(timeout).toBeFocused();
        await expect(timeout.locator("..").locator(".field-diagnostics")).toContainText("LINT_TIMEOUT_BELOW_LATENCY");
        await expect(page.getByRole("button", { name: label("app.topBar.run"), exact: true })).toBeEnabled();
      });
    }

    test("localizes unreachable timeout warnings and opens the affected connection", async ({ page }) => {
      await page.goto("/");
      await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
      await page.getByTestId("rf__node-client").click();
      const deadline = page.getByLabel(catalog["catalog.types.client.params.deadline.title"] ?? "Deadline", { exact: true });
      await deadline.fill("100.124ms");
      await deadline.press("Enter");
      await page.getByTestId("canvas-edge-label-middle-to-dependency").click();
      const timeout = page.getByLabel(catalog["catalog.types.call.params.timeout.title"] ?? "Timeout", { exact: true });
      await timeout.fill("100.124ms");
      await timeout.press("Enter");
      await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
      const warning = page.getByRole("tabpanel").locator('button[data-diagnostic-code="LINT_TIMEOUT_UNREACHABLE"]');

      await expect(warning).toBeVisible();
      await expect(warning).toContainText(locale.startsWith("ru") ? "Таймаут 100.124 мс" : "Timeout 100.124 ms");
      await expect(warning).toContainText("'client': 100.124");
      await warning.click();
      await expect(timeout).toBeFocused();
      await expect(timeout.locator("..").locator(".field-diagnostics")).toContainText("LINT_TIMEOUT_UNREACHABLE");
    });

    test("localizes linter, inspector validation and estimate warnings from the real API", async ({ page }, testInfo) => {
      await page.goto("/");
      await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
      await page.getByRole("button", { name: label("results.restore"), exact: true }).click();
      await page.getByRole("tab", { name: label("results.problems.title"), exact: true }).click();
      const lint = page.getByRole("tabpanel").locator('button[data-diagnostic-code="LINT_TIMEOUT_BUDGET"]');
      await expect(lint).toContainText(locale.startsWith("ru") ? /Таймаут 80 мс/ : "Timeout 80 ms");
      await expect(lint).toContainText("189");

      await page.getByRole("tab", { name: label("editor.pages.model"), exact: true }).click();
      await page.getByTestId("rf__node-gateway").click();
      const handlers = page.getByLabel(catalog["catalog.types.service.params.handlers.title"] ?? "Handlers", { exact: true });
      const original = await handlers.inputValue();
      await handlers.fill("0");
      await handlers.press("Enter");
      const validation = handlers.locator("..").locator(".field-diagnostics");
      await expect(validation).toContainText("PARAM_RANGE");
      await expect(validation).toContainText(locale.startsWith("ru") ? /[Пп]араметра? [«']Обработчики/ : "Parameter 'Handlers · gateway'");
      await handlers.locator("..").locator(".field-feedback:not(.field-feedback--variants) button").press("Enter");
      await expect(validation).toBeVisible();
      if (locale.startsWith("ru")) await page.screenshot({ path: testInfo.outputPath("russian-backend-validation.png") });
      await handlers.fill(original);
      await handlers.press("Enter");
      await expect(validation).toBeHidden();

      await page.getByRole("tab", { name: label("editor.pages.model"), exact: true }).click();
      const window = page.getByLabel(label("editor.run.seriesWindow"), { exact: true });
      await window.fill("1ms");
      await window.press("Enter");
      const measurement = page.getByLabel(label("editor.run.measurement"), { exact: true });
      await measurement.fill("1000s");
      await measurement.press("Enter");
      const estimate = page.getByRole("button", { name: label("app.estimate.label"), exact: true });
      await expect(estimate).toBeEnabled();
      await estimate.click();
      await expect(page.getByRole("region", { name: label("app.estimate.cost"), exact: true }))
        .toContainText(locale.startsWith("ru") ? /64 МиБ/ : "64 MiB UI cache budget");
    });
  });
}
