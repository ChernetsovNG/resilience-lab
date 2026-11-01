import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile } from "../src/api/apiTypes";
import type { components } from "../src/api/schema";
import { cleanupWorkspace, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 } });

for (const language of ["en", "ru"] as const) {
  test(`canvas policy badges, inspector navigation and recorded playback in ${language}`, async ({ page, request }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `canvas-policies-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const source = resolve("../examples/checkout-replicas");
      const model: ModelFile = JSON.parse(await readFile(resolve(source, "checkout-replicas.model.json"), "utf8"));
      const experiment: ExperimentFile = JSON.parse(await readFile(resolve(source, "checkout-replicas.experiment.json"), "utf8"));
      model.blocks["mobile-app"].params.load = { points: [{ time: "0s", rate: "120/s" }] };
      model.blocks["mobile-app"].params.deadline = "500ms";
      model.blocks.psp.params.processing = { kind: "fixed", mean: "2ms" };
      model.blocks["payment-service"].params.processing = { kind: "fixed", mean: "1ms" };
      model.blocks["api-gateway"].params.rateLimit = { rate: "10000/s", burst: 100 };
      model.blocks["order-service"].replicaOverrides = { "2": { processing: { kind: "fixed", mean: "200ms" } } };
      model.blocks["order-service"].params.healthCheck = { interval: "50ms", timeout: "20ms", unhealthyThreshold: 2, healthyThreshold: 1, processing: "1ms" };
      const incoming = model.connections.find(edge => edge.id === "api-gateway-to-order-service")!;
      incoming.params = { ...incoming.params, timeout: "50ms", attempts: 1,
        circuitBreaker: { failureRate: "100%", minimumCalls: 100, window: 100, openDuration: "200ms", halfOpenCalls: 1 },
        retryBudget: { ratio: "20%", minPerSecond: "10/s", window: "1s" },
        fallback: { on: ["timeout", "circuitOpen"], processing: "1ms" },
        outlierDetection: { consecutiveFailures: 1, baseEjection: "300ms", maxEjected: "34%" } };
      const payment = model.connections.find(edge => edge.id === "order-service-to-payment-service")!;
      payment.params = { ...payment.params, timeout: "10ms", circuitBreaker: {
        failureRate: "50%", minimumCalls: 2, window: 4, openDuration: "100ms", halfOpenCalls: 1,
      }, fallback: { on: ["timeout", "circuitOpen"], processing: "1ms" } };
      const database = model.connections.find(edge => edge.id === "order-service-to-pgbouncer")!;
      database.params.retryBudget = { ratio: "20%", minPerSecond: "10/s", window: "1s" };
      const policies = Object.fromEntries([
        ["api-gateway.rateLimit", model.blocks["api-gateway"].params.rateLimit],
        ["order-service.healthCheck", model.blocks["order-service"].params.healthCheck],
        ...["circuitBreaker", "retryBudget", "fallback", "outlierDetection"].map(policy => [`${incoming.id}.${policy}`, incoming.params[policy]]),
        ...["circuitBreaker", "fallback"].map(policy => [`${payment.id}.${policy}`, payment.params[policy]]),
        [`${database.id}.retryBudget`, database.params.retryBudget],
      ]);
      experiment.execution = { ...experiment.execution, warmup: "100ms", measurement: "1500ms", window: "100ms", replications: 1 };
      experiment.variants = [{ id: "plain", label: ru ? "Без политик" : "No policies", overrides: Object.fromEntries(Object.keys(policies).map(key => [key, null])) },
        { id: "policies", label: ru ? "С политиками" : "Policies", overrides: policies }];
      experiment.faults = [{ kind: "blackhole", target: "psp", from: "300ms", to: "800ms" }];
      experiment.grid = [];
      await writeFile(resolve(root, "checkout-replicas.model.json"), JSON.stringify(model));
      await writeFile(resolve(root, "checkout-replicas.experiment.json"), JSON.stringify(experiment));
      await copyFile(resolve(source, "checkout-replicas.layout.json"), resolve(root, "checkout-replicas.layout.json"));
      await page.goto("/");
      await selectExperiment(page, `${directory}/checkout-replicas.experiment.json`);
      const dimensions = () => page.locator(".block-shape, .canvas-edge-label").evaluateAll(elements => elements.map(element => ({
        id: element.closest("[data-id]")?.getAttribute("data-id") ?? element.getAttribute("data-testid"),
        width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight,
      })));
      await page.getByRole("tab", { name: ru ? "Без политик" : "No policies", exact: true }).click();
      await expect(page.getByTestId(`canvas-policies-${payment.id}`)).toHaveCount(0);
      const withoutPolicies = await dimensions();
      await page.getByRole("tab", { name: ru ? "С политиками" : "Policies", exact: true }).click();
      const badge = page.getByTestId(`canvas-policies-${payment.id}`).getByRole("button", { name: ru ? "Предохранитель вызовов" : "Circuit breaker", exact: true });
      await expect(badge).toBeVisible();
      const paymentBadges = (await page.getByTestId(`canvas-policies-${payment.id}`).boundingBox())!;
      const databaseBadges = (await page.getByTestId(`canvas-policies-${database.id}`).boundingBox())!;
      expect(paymentBadges.y + paymentBadges.height <= databaseBadges.y || databaseBadges.y + databaseBadges.height <= paymentBadges.y).toBe(true);
      const withPolicies = await dimensions();
      expect(withPolicies).toEqual(withoutPolicies);
      const densityPath = testInfo.outputPath("policy-density.json");
      await writeFile(densityPath, JSON.stringify({ language, withoutPolicies, withPolicies }, null, 2));
      await testInfo.attach("policy-density.json", { path: densityPath, contentType: "application/json" });
      const more = page.getByTestId(`canvas-policies-${incoming.id}`).locator("summary");
      await expect(more).toHaveText("+2");
      await expect(more).toHaveAttribute("title", ru ? /Вывод неисправных экземпляров/ : /Outlier detection/);
      await more.click();
      await page.getByTestId(`canvas-policies-${incoming.id}`).getByRole("button", { name: ru ? "Бюджет повторов" : "Retry budget", exact: true }).click();
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector" });
      await expect(inspector.locator('[data-inspector-field="retryBudget"]')).toBeInViewport();
      await badge.click();
      const breakerSection = inspector.locator('[data-policy="circuitBreaker"]');
      const parameters = inspector.locator(".inspector-parameters");
      await expect(breakerSection).toHaveAttribute("open");
      await expect(inspector.locator('[data-inspector-field="circuitBreaker"]')).toBeInViewport();
      await breakerSection.locator(":scope > summary").click();
      await parameters.locator(":scope > summary").click();
      await badge.click();
      await expect(parameters).toHaveAttribute("open");
      await expect(breakerSection).toHaveAttribute("open");
      await expect(inspector.locator('[data-inspector-field="circuitBreaker"]')).toBeInViewport();
      if (ru) await page.screenshot({ path: testInfo.outputPath("canvas-policy-inspector-ru.png") });
      const completed = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true }).click();
      const runId = /\/runs\/([^/]+)\/summary$/.exec((await completed).url())![1];
      await page.getByRole("button", { name: ru ? "Вместить схему" : "Fit View", exact: true }).click();
      const route = `/api/v1/runs/${runId}/series/policies/p0/0`;
      const index: components["schemas"]["SeriesIndex"] = await (await request.get(route)).json();
      const nodes = new Map<string, components["schemas"]["WindowMetrics"][]>();
      const connections = new Map<string, components["schemas"]["ConnectionWindowMetrics"][]>();
      for (const reference of index.parts) {
        const number = reference.file.replace(/^part-(\d+)\.json\.gz$/, "$1");
        const part: components["schemas"]["SeriesPart"] = await (await request.get(`${route}/${number}`)).json();
        for (const node of part.nodes) nodes.set(node.id, [...(nodes.get(node.id) ?? []), ...node.windows]);
        for (const connection of part.connections) connections.set(connection.id, [...(connections.get(connection.id) ?? []), ...connection.windows]);
      }
      const windows = connections.get(payment.id)!;
      const open = windows.findIndex(window => window.startMs >= 300 && window.startMs < 800 && window.circuitOpenMs > 0);
      const closed = windows.findIndex(window => window.startMs >= 1100 && window.circuitOpenMs === 0);
      expect(open).toBeGreaterThanOrEqual(0);
      expect(closed).toBeGreaterThan(open);
      const slider = page.getByRole("slider", { name: ru ? "Окно воспроизведения" : "Playback window", exact: true });
      await page.getByRole("button", { name: ru ? "Время" : "Time", exact: true }).click();
      await slider.fill(String(open));
      await expect(badge).toHaveClass(/policy-badge--active/);
      const edge = page.locator(`[data-id="${payment.id}"] .react-flow__edge-path`);
      await expect(edge).toHaveCSS("stroke-dasharray", "6px, 4px");
      await expect(badge).toHaveAttribute("title", ru ? /окна/ : /of window/);
      if (ru) await page.screenshot({ path: testInfo.outputPath("canvas-policy-open-ru.png") });
      await slider.fill(String(closed));
      await expect(badge).not.toHaveClass(/policy-badge--active/);
      await expect(edge).toHaveCSS("stroke-dasharray", "none");
      if (ru) await page.screenshot({ path: testInfo.outputPath("canvas-policy-closed-ru.png") });
      const excluded = nodes.get("order-service#2")!.findIndex(window => window.ejectedMs > 0);
      expect(excluded).toBeGreaterThanOrEqual(0);
      await slider.fill(String(excluded));
      const replica = page.getByTestId("rf__node-order-service").locator('[data-replicas="2"]');
      await expect(replica).toHaveClass(/policy-replica--inactive/);
      await expect(replica).toHaveCSS("opacity", "0.4");
      if (ru) await page.screenshot({ path: testInfo.outputPath("canvas-policy-replica-ru.png") });
      await page.getByTestId("rf__node-order-service").locator(".block-node > strong").click();
      const replicas = inspector.getByRole("table", { name: `${ru ? "Реплики" : "Replicas"} · order-service`, exact: true });
      await replicas.getByRole("button", { name: "order-service#2", exact: true }).click();
      await page.getByTestId("canvas-policies-order-service").getByRole("button").click();
      await expect(inspector.locator('[data-inspector-field="healthCheck"]')).toBeInViewport();
      await page.getByRole("button", { name: ru ? "Итог" : "Summary", exact: true }).click();
      await expect(badge).not.toHaveClass(/policy-badge--active/);
      await expect(replica).not.toHaveClass(/policy-replica--inactive/);
      expect(JSON.parse(await readFile(resolve(root, "checkout-replicas.model.json"), "utf8"))).toEqual(model);
    } finally { await cleanupWorkspace(page, root); }
  });
}
