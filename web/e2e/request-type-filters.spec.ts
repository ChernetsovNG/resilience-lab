import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile, RunSummary } from "../src/api/apiTypes";
import { copySmallExperiment, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1920, height: 1080 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`filters scenario steps and routes, repairs a missing route, persists and runs in ${language}`, async ({ page }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `request-type-filters-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    let jobs = 0;
    page.on("request", request => { if (request.url().endsWith("/api/v1/jobs") && request.method() === "POST") jobs += 1; });
    try {
      const experiment = await copySmallExperiment(root);
      experiment.execution = { ...experiment.execution, warmup: "0s", measurement: "1s", window: "100ms" };
      experiment.variants = experiment.variants.filter(variant => variant.id === "baseline");
      experiment.faults = [];
      const source: ModelFile = JSON.parse(await readFile(resolve(root, "retry-storm.model.json"), "utf8"));
      const client = structuredClone(source.blocks.client);
      delete client.params.load;
      client.params.classes = ["status", "checkout"].map(id => ({ id, load: { points: [{ time: "0s", rate: "20/s" }] } }));
      const call = source.connections.find(edge => edge.type === "call")!;
      const model: ModelFile = { ...source, blocks: {
        "mobile-app": client,
        "api-gateway": source.blocks.gateway,
        "order-router": { type: "router", params: { policy: "roundRobin" } },
        "order-service": { ...source.blocks.middle, scenario: [{ type: "process" }, { type: "call", connection: "order-to-payment" }] },
        "order-service-v2": source.blocks.middle,
        "payment-service": source.blocks.dependency,
      }, connections: [
        { ...source.connections.find(edge => edge.type === "request")!, from: "mobile-app", to: "api-gateway" },
        { ...call, id: "gateway-to-router", from: "api-gateway", to: "order-router" },
        { id: "order-route", type: "route", from: "order-router", to: "order-service", params: {}, classes: ["status"] },
        { id: "order-route-v2", type: "route", from: "order-router", to: "order-service-v2", params: {}, classes: ["status", "checkout"] },
        { ...call, id: "order-to-payment", from: "order-service", to: "payment-service" },
      ] };
      await writeFile(resolve(root, "retry-storm.model.json"), JSON.stringify(model));
      await writeFile(resolve(root, "retry-storm.experiment.json"), JSON.stringify(experiment));
      const positions = {
        "mobile-app": { x: 0, y: 160 }, "api-gateway": { x: 260, y: 160 }, "order-router": { x: 540, y: 160 },
        "order-service": { x: 820, y: 0 }, "order-service-v2": { x: 820, y: 360 }, "payment-service": { x: 1120, y: 0 },
      };
      await writeFile(resolve(root, "retry-storm.layout.json"), JSON.stringify({ schemaVersion: 2, sizes: {}, edges: {}, positions }));
      await page.goto("/");
      await selectExperiment(page, `${directory}/retry-storm.experiment.json`);
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector", exact: true });
      await page.getByTestId("rf__node-order-service").locator(".block-node > strong").click();
      const parameters = inspector.locator(".inspector-parameters");
      if (await parameters.getAttribute("open") !== null) await parameters.locator("summary").click();
      const step = inspector.getByRole("group", { name: ru ? "Шаг 2" : "Step 2", exact: true });
      const execute = step.getByRole("group", { name: ru ? "Выполнять для" : "Execute for", exact: true });
      await execute.getByRole("checkbox", { name: "checkout", exact: true }).check();
      await expect(execute.getByRole("checkbox", { name: "status", exact: true })).not.toBeChecked();
      if (ru) {
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("request-type-step-ru.png") });
      }

      const route = page.getByTestId("canvas-edge-label-order-route-v2");
      await route.click();
      if (await parameters.getAttribute("open") === null) await parameters.locator("summary").click();
      const routing = inspector.getByRole("group", { name: ru ? "Направлять в order-service-v2" : "Route to order-service-v2", exact: true });
      await routing.getByRole("checkbox", { name: "checkout", exact: true }).uncheck();
      await expect(route.getByText("status", { exact: true })).toBeVisible();
      const router = page.getByTestId("rf__node-order-router");
      const missingRoute = router.locator('.diagnostic-badge[title*="checkout"]');
      const missingRouteMessage = ru ? "У маршрутизатора «order-router» нет маршрута для вида запроса «checkout»"
        : "Router 'order-router' has no route for request type 'checkout'";
      await expect(missingRoute).toBeVisible();
      await expect(missingRoute).toHaveAttribute("title", missingRouteMessage);
      const run = page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true });
      await run.click();
      const problems = page.getByRole("tabpanel", { name: ru ? "Проблемы" : "Problems", exact: true });
      await expect(problems).toContainText(missingRouteMessage);
      expect(jobs).toBe(0);
      if (ru) {
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("request-type-no-route-ru.png") });
      }
      await routing.getByRole("checkbox", { name: "checkout", exact: true }).check();
      await expect(missingRoute).toHaveCount(0);
      await expect(run).toBeEnabled();
      await page.getByRole("button", { name: ru ? "Сохранить" : "Save", exact: true }).click();
      await expect(page.getByText(ru ? "Несохранённые изменения" : "Unsaved changes", { exact: true })).toBeHidden();
      const modelURL = `/api/v1/workspace/document?path=${encodeURIComponent(`${directory}/retry-storm.model.json`)}`;
      const stored: ModelFile = (await (await page.request.get(modelURL)).json()).content.model;
      expect(stored.blocks["order-service"].scenario![1].classes).toEqual(["checkout"]);
      expect(stored.connections.find(edge => edge.id === "order-route-v2")!.classes).toEqual(["status", "checkout"]);
      expect(stored.connections.find(edge => edge.id === "order-route-v2")!.params).not.toHaveProperty("classes");
      await page.reload();
      await route.click();
      await expect(routing.getByRole("checkbox", { name: "checkout", exact: true })).toBeChecked();
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      await expect(routing.getByRole("checkbox", { name: "checkout", exact: true })).toBeDisabled();
      if (ru) {
        await page.mouse.move(700, 100);
        await page.screenshot({ path: testInfo.outputPath("request-type-route-ru.png") });
      }
      const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await run.click();
      const summary: RunSummary = await (await response).json();
      await expect(page.getByTestId("job-status")).toHaveText(ru ? "ЗАВЕРШЕНО" : "COMPLETED");
      expect(jobs).toBe(1);
      const aggregate = summary.variants[0].points[0].aggregate;
      expect(Object.keys(aggregate.entries.classes).sort()).toEqual(["checkout", "status"]);
      expect(aggregate.connections["order-route-v2"].totals.sentAttempts).toBeGreaterThan(0);
      expect(aggregate.connections["order-to-payment"].totals.sentAttempts).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
