import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, ModelFile, RunSummary, SeriesIndex } from "../src/api/apiTypes";
import { cleanupWorkspace, expect, selectExperiment, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000 });

for (const language of ["en", "ru"] as const) {
  test(`policy results: slow replica, breaker windows and request types in ${language}`, async ({ page, request }, testInfo) => {
    const ru = language === "ru";
    await page.addInitScript(language => localStorage.setItem("resilience-lab.language", language), language);
    const directory = `policy-results-${randomUUID()}`;
    const root = resolve("../apps/server/build/e2e-workspace", directory);
    await mkdir(root);
    try {
      const source = resolve("../examples/checkout-replicas");
      const model: ModelFile = JSON.parse(await readFile(resolve(source, "checkout-replicas.model.json"), "utf8"));
      const experiment: ExperimentFile = JSON.parse(await readFile(resolve(source, "checkout-replicas.experiment.json"), "utf8"));
      const client = model.blocks["mobile-app"];
      client.params.deadline = "500ms";
      client.params.classes = ["status", "checkout"].map(id => ({ id, load: { points: [{ time: "0s", rate: "60/s" }] } }));
      delete client.params.load;
      model.blocks.psp.params.processing = { kind: "fixed", mean: "2ms" };
      model.blocks["payment-service"].params.processing = { kind: "fixed", mean: "50ms" };
      const orders = model.blocks["order-service"];
      orders.replicaOverrides = { "2": { processing: { kind: "fixed", mean: "200ms" } } };
      orders.params.healthCheck = { interval: "50ms", timeout: "20ms", unhealthyThreshold: 2, healthyThreshold: 1, processing: "1ms" };
      orders.params.rateLimit = { rate: "10000/s", burst: 100 };
      orders.scenario!.find(step => step.type === "call" && step.connection === "order-service-to-payment-service")!.classes = ["checkout"];
      const incoming = model.connections.find(connection => connection.id === "api-gateway-to-order-service")!;
      incoming.params = { ...incoming.params, timeout: "50ms", attempts: 1,
        outlierDetection: { consecutiveFailures: 1, baseEjection: "300ms", maxEjected: "34%" } };
      const payment = model.connections.find(connection => connection.id === "order-service-to-payment-service")!;
      payment.params = { ...payment.params, timeout: "10ms", circuitBreaker: {
        failureRate: "50%", minimumCalls: 2, window: 4, openDuration: "200ms", halfOpenCalls: 1,
      }, fallback: { on: ["timeout", "circuitOpen"], processing: "1ms" } };
      experiment.execution = { ...experiment.execution, warmup: "100ms", measurement: "1500ms", window: "100ms", replications: 2 };
      experiment.variants = [{ id: "baseline", label: "Policies" }];
      experiment.faults = []; experiment.grid = [];
      await writeFile(resolve(root, "checkout-replicas.model.json"), JSON.stringify(model));
      await writeFile(resolve(root, "checkout-replicas.experiment.json"), JSON.stringify(experiment));
      await copyFile(resolve(source, "checkout-replicas.layout.json"), resolve(root, "checkout-replicas.layout.json"));
      await page.goto("/");
      await selectExperiment(page, `${directory}/checkout-replicas.experiment.json`);
      const completed = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
      await page.getByRole("button", { name: ru ? "Запустить" : "Run", exact: true }).click();
      const response = await completed;
      const summary: RunSummary = await response.json();
      const runId = /\/runs\/([^/]+)\/summary$/.exec(response.url())![1];
      const seriesPath = `/api/v1/runs/${runId}/series/baseline/p0/0`;
      const index: SeriesIndex = await (await request.get(seriesPath)).json();
      const parts: number[] = [];
      await page.route(`**${seriesPath}/*`, async intercepted => {
        parts.push(Number(intercepted.request().url().split("/").at(-1)));
        await intercepted.continue();
      });
      const aggregate = summary.variants[0].points[0].aggregate;
      expect(aggregate.services["order-service#2"].totals.ejectedMs).toBeGreaterThan(0);
      expect(aggregate.connections[payment.id].totals.circuitOpenMs).toBeGreaterThan(0);
      await page.getByRole("tab", { name: "Policies", exact: true }).click();
      await page.getByTestId("rf__node-order-service").locator(".block-node > strong").click();
      const inspector = page.getByRole("complementary", { name: ru ? "Инспектор" : "Inspector" });
      const table = inspector.getByRole("table", { name: `${ru ? "Реплики" : "Replicas"} · order-service`, exact: true });
      await table.getByRole("button", { name: ru ? "Выведена" : "Ejected", exact: true }).click();
      await expect(table.getByRole("row").nth(1)).toContainText("#2");
      await expect(table.getByRole("button", { name: ru ? "Не готова" : "Not ready", exact: true })).toBeVisible();
      await expect(table.getByRole("button", { name: ru ? "Отклонены ограничением" : "Rate-limited", exact: true })).toBeVisible();
      if (ru) await page.screenshot({ path: testInfo.outputPath("policy-replicas-ru.png") });
      await table.getByRole("button", { name: "order-service#2", exact: true }).click();
      await inspector.getByRole("button", { name: ru ? "Показать на таймлайне" : "Show on Timeline", exact: true }).click();
      await expect(page.getByRole("tab", { name: ru ? "Таймлайн" : "Timeline", exact: true })).toHaveAttribute("aria-selected", "true");
      const utilization = page.getByRole("region", { name: ru ? "Загрузка" : "Utilization", exact: true });
      await expect(utilization).toContainText(`order-service#2 · ${ru ? "Загрузка обработчиков" : "Handler utilization"}`);
      await expect(utilization).toContainText(`order-service · ${ru ? "Загрузка обработчиков" : "Handler utilization"}`);
      await expect(utilization.locator(".timeline-readout dt")).toHaveCount(2);
      const ejected = page.getByRole("slider", { name: new RegExp(`${ru ? "выведен" : "Ejected"}.*order-service#2`) });
      await expect(ejected).toBeVisible();
      await expect.poll(async () => ejected.locator("rect[data-share]").evaluateAll(rects => rects.some(rect => Number(rect.getAttribute("data-share")) > 0))).toBe(true);
      await expect(page.getByRole("slider", { name: new RegExp(`${ru ? "не готов" : "Not ready"}.*order-service#2`) })).toBeVisible();
      const instanceParts = parts.map(number => index.parts.find(part => part.file === `part-${number}.json.gz`)!)
        .filter(part => part.kind === "INSTANCE");
      expect(instanceParts.length).toBeGreaterThan(0);
      // A short run can pack several replicas together; no INSTANCE part unrelated to #2 is needed.
      expect(instanceParts.every(part => part.nodes.includes("order-service#2"))).toBe(true);
      if (ru) {
        await page.getByRole("button", { name: "Анализ", exact: true }).click();
        await page.locator(".timeline").evaluate(element => {
          for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) parent.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath("policy-ejected-timeline-ru.png") });
        await page.getByRole("button", { name: "Анализ", exact: true }).click();
      }
      await page.getByText(ru ? "Элементы и показатели" : "Elements and metrics", { exact: true }).click();
      const call = page.getByRole("group").filter({ has: page.getByRole("checkbox", { name: /order-service → payment-service \(order-service-to-payment-service\)/, exact: true }) });
      await call.getByRole("checkbox", { name: /order-service → payment-service \(order-service-to-payment-service\)/, exact: true }).check();
      for (const id of ["status", "checkout"]) {
        const name = `${ru ? "Вид запроса" : "Request type"} · ${id}`;
        await page.getByRole("checkbox", { name, exact: true }).check();
        const choices = page.getByRole("group", { name, exact: true });
        await choices.getByRole("checkbox", { name: ru ? "Успешные" : "Successes", exact: true }).check();
        await choices.getByRole("checkbox", { name: ru ? "Ошибки" : "Failures", exact: true }).check();
      }
      await page.getByText(ru ? "Элементы и показатели" : "Elements and metrics", { exact: true }).click();
      const breaker = page.getByRole("slider", { name: new RegExp(`${ru ? "Предохранитель вызовов разомкнут" : "Circuit breaker open"}.*order-service-to-payment-service\\)`) });
      await expect(breaker).toBeVisible();
      await expect.poll(async () => breaker.locator("rect[data-share]").evaluateAll(rects => rects.some(rect => Number(rect.getAttribute("data-share")) > 0))).toBe(true);
      const shares = await breaker.locator("rect[data-share]").evaluateAll(rects => rects.map(rect => Number(rect.getAttribute("data-share"))));
      expect(shares.every(share => share >= 0 && share <= 1)).toBe(true);
      await expect(breaker.locator("title").first()).toContainText(ru ? "по 3 репликам вызывающего" : "3 caller replicas");
      await breaker.press("End");
      await expect(page.getByRole("slider", { name: ru ? "Окно воспроизведения" : "Playback window", exact: true })).toHaveValue("15");
      const rates = page.getByRole("region", { name: ru ? "Интенсивности" : "Rates", exact: true });
      await expect(rates).toContainText(`${ru ? "Вид запроса" : "Request type"} · checkout · ${ru ? "Успешные" : "Successes"}`);
      await expect(page.getByRole("region", { name: ru ? "Ошибки и отказы" : "Errors and rejections", exact: true }))
        .toContainText(`${ru ? "Вид запроса" : "Request type"} · status · ${ru ? "Ошибки" : "Failures"}`);
      if (ru) {
        await page.getByRole("button", { name: "Анализ", exact: true }).click();
        await page.locator(".timeline").evaluate(element => {
          for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) parent.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath("policy-breaker-request-types-ru.png") });
        await breaker.locator("..").screenshot({ path: testInfo.outputPath("policy-breaker-window-ru.png") });
      }
      expect(JSON.parse(await readFile(resolve(root, "checkout-replicas.model.json"), "utf8"))).toEqual(model);
    } finally { await cleanupWorkspace(page, root); }
  });
}
