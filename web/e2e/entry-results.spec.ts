import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, ModelFile, RunSummary } from "../src/api/apiTypes";
import { formatPercent } from "../src/i18n/format";
import { setLanguage } from "../src/i18n";
import { cleanupWorkspace, expect, selectExperiment, test } from "./fixtures";

test.use({ locale: "ru-RU", viewport: { width: 1440, height: 1600 }, actionTimeout: 10_000 });

test("compares clients, request types and refusal reasons, then selects checkout on Map", async ({ page }, testInfo) => {
  const directory = `entry-results-${randomUUID()}`;
  const target = resolve("../apps/server/build/e2e-workspace", directory);
  const classes = [
    { id: "status", load: { points: [{ time: "0s", rate: "80/s" }] } },
    { id: "checkout", load: { points: [{ time: "0s", rate: "40/s" }] } },
  ];
  const model: ModelFile = { schemaVersion: 7, blocks: {
    "mobile-app": { type: "client", params: { deadline: "1s", classes } },
    "partner-api": { type: "client", params: { deadline: "1s", classes: [classes[0]] } },
    "api-gateway": { type: "service", params: { handlers: 40, queue: 100, processing: { kind: "fixed", mean: "1ms" } },
      scenario: [{ type: "process" }, { type: "call", connection: "gateway-to-orders", classes: ["checkout"] }] },
    "order-service": { type: "service", params: { handlers: 8, queue: 100, processing: { kind: "fixed", mean: "30ms" } } },
  }, connections: [
    { id: "mobile-request", type: "request", from: "mobile-app", to: "api-gateway", params: {} },
    { id: "partner-request", type: "request", from: "partner-api", to: "api-gateway", params: {} },
    { id: "gateway-to-orders", type: "call", from: "api-gateway", to: "order-service", params: {
      timeout: "10ms", attempts: 1, circuitBreaker: { failureRate: "50%", minimumCalls: 5, window: 10, openDuration: "100ms", halfOpenCalls: 1 },
    } },
  ] };
  const experiment: ExperimentFile = { schemaVersion: 4, modelRef: "checkout-policies.model.json", layoutRef: "checkout-policies.layout.json",
    execution: { replications: 5, warmup: "100ms", measurement: "1s", window: "50ms", seed: 426, maxRealTime: "30s" }, faults: [],
    variants: [{ id: "baseline", label: "Baseline", overrides: {} }, { id: "fallback", label: "Fallback", overrides: {
      "gateway-to-orders.fallback": { on: ["timeout", "circuitOpen"], processing: "1ms" }, "api-gateway.failureRate": "5%",
    } }], grid: [{ path: "gateway-to-orders.timeout", values: ["10ms", "100ms"] }] };
  const layout: LayoutFile = { schemaVersion: 2, sizes: {}, edges: {}, positions: {
    "mobile-app": { x: 0, y: 0 }, "partner-api": { x: 0, y: 160 }, "api-gateway": { x: 260, y: 80 }, "order-service": { x: 520, y: 80 },
  } };
  await mkdir(target);
  try {
    await Promise.all(Object.entries({ model, experiment, layout }).map(([kind, document]) =>
      writeFile(resolve(target, `checkout-policies.${kind}.json`), JSON.stringify(document))));
    await setLanguage("ru");
    await page.goto("/");
    await selectExperiment(page, `${directory}/checkout-policies.experiment.json`);
    const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    const baseline = summary.variants.find(variant => variant.id === "baseline")!;
    const fallback = summary.variants.find(variant => variant.id === "fallback")!;
    expect(baseline.points[0].aggregate.entries.classes.status.failuresByReason).toEqual({});
    expect(fallback.points[0].aggregate.entries.classes.status.failuresByReason.error.mean).toBeGreaterThan(0);
    expect(fallback.points[0].aggregate.entries.total.degradedRate!.mean).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await page.getByRole("button", { name: "Анализ", exact: true }).click();
    const clients = page.getByText("По клиентам", { exact: true }).locator("..");
    const types = page.getByText("По видам запросов", { exact: true }).locator("..");
    await expect(clients).not.toHaveAttribute("open", "");
    await expect(types).not.toHaveAttribute("open", "");
    await clients.locator(":scope > summary").click();
    const clientTable = page.getByRole("table", { name: "Клиент · mobile-app", exact: true });
    await expect(clientTable.getByRole("row", { name: /Доля успешных/ }).getByRole("cell").first())
      .toContainText(formatPercent(baseline.points[0].aggregate.entries.clients["mobile-app"].successRate!.mean));
    await expect(page.getByRole("table", { name: "Клиент · partner-api", exact: true })).toBeVisible();
    await clients.evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: testInfo.outputPath("clients-ru.png") });
    await clients.locator(":scope > summary").click();
    await types.locator(":scope > summary").click();
    const status = page.getByRole("table", { name: "Вид запроса · status", exact: true });
    await expect(status.getByRole("row", { name: /Причины отказа/ }).getByRole("cell").first()).toContainText("нет отказов");
    await expect(status.getByRole("row", { name: /Причины отказа/ }).getByRole("cell").nth(1)).toContainText("ошибка обработки");
    const checkout = page.getByRole("table", { name: "Вид запроса · checkout", exact: true });
    await expect(checkout.getByRole("row", { name: /Успешные с fallback/ }).getByRole("cell").nth(1))
      .toContainText(formatPercent(fallback.points[0].aggregate.entries.classes.checkout.degradedRate!.mean));
    const statusReasons = status.getByRole("row", { name: /Причины отказа/ }).getByRole("cell");
    await statusReasons.first().locator("summary").click();
    await statusReasons.nth(1).locator("summary").click();
    await expect(statusReasons.first()).toContainText(formatPercent(0));
    await types.evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: testInfo.outputPath("request-types-ru.png") });

    await page.getByRole("tab", { name: "Карта", exact: true }).click();
    await page.getByRole("combobox", { name: "Вход", exact: true }).selectOption("classes:checkout");
    const points = page.getByRole("list", { name: "Точки карты", exact: true }).getByRole("button");
    for (const [index, point] of baseline.points.entries()) await expect(points.nth(index))
      .toContainText(formatPercent(point.aggregate.entries.classes.checkout.successRate!.mean));
    await points.nth(1).click();
    await expect(page.getByLabel("Точка сетки", { exact: true })).toHaveValue("p1");
    await page.screenshot({ path: testInfo.outputPath("map-checkout-ru.png") });
    await page.getByRole("button", { name: "Анализ", exact: true }).click();
    await page.getByTestId("rf__node-mobile-app").locator(".block-node > strong").click();
    const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
    const clientResults = inspector.getByRole("table", { name: "Результаты", exact: true });
    await expect(clientResults.getByRole("row", { name: /Доля успешных/ }))
      .toContainText(formatPercent(baseline.points[1].aggregate.entries.clients["mobile-app"].successRate!.mean));
    await expect(inspector.getByText("Результаты вида запроса суммарные по всем клиентам, которые его отправляют.")).toBeVisible();
    await expect(inspector.locator(".inspector-parameters")).not.toHaveAttribute("open", "");
    expect(await clientResults.evaluate(element => Boolean(element.closest(".element-results")!
      .compareDocumentPosition(document.querySelector(".inspector-parameters")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("client-inspector-ru.png") });
  } finally {
    await setLanguage("en");
    await cleanupWorkspace(page, target);
  }
});
