import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ModelFile, RunSummary, SeriesIndex } from "../src/api/apiTypes";
import type { components } from "../src/api/schema";
import { dragConnection } from "./canvasGestures";
import { readWorkspaceDocument, cleanupWorkspace, expect, selectExperiment, test } from "./fixtures";

test.use({ locale: "ru-RU", viewport: { width: 1920, height: 1080 }, actionTimeout: 10_000 });

test("published checkout-policies compares PSP outcomes and replays the breaker", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await selectExperiment(page, "checkout-policies/psp-outage.experiment.json");
  await expect(page.getByTestId("block-node")).toHaveCount(8);
  const completed = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()), { timeout: 120_000 });
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  const response = await completed;
  const summary: RunSummary = await response.json();
  await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
  const metrics = (id: string) => summary.variants.find(variant => variant.id === id)!.points[0].aggregate;
  const baseline = metrics("baseline"), breaker = metrics("circuit-breaker"), fallback = metrics("fallback");
  expect(breaker.entries.classes.status.successRate!.ci95Low!)
    .toBeGreaterThan(baseline.entries.classes.status.successRate!.ci95High!);
  expect(fallback.entries.classes.checkout.successRate!.mean).toBeGreaterThan(breaker.entries.classes.checkout.successRate!.mean);
  expect(fallback.entries.total.degradedRate!.mean).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Оплата будет позже", exact: true }).click();
  await page.getByRole("button", { name: "Анализ", exact: true }).click();
  await page.getByText("По видам запросов", { exact: true }).click();
  const status = page.getByRole("table", { name: "Вид запроса · status", exact: true });
  const checkout = page.getByRole("table", { name: "Вид запроса · checkout", exact: true });
  await expect(status.getByRole("row", { name: /Доля успешных/ })).toBeVisible();
  await expect(checkout.getByRole("row", { name: /Успешные с fallback/ })).toBeVisible();
  await checkout.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("checkout-policies-results-ru.png") });
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("checkout-policies-status-ru.png") });
  await page.getByRole("button", { name: "Анализ", exact: true }).click();

  const runId = /\/runs\/([^/]+)\/summary$/.exec(response.url())![1];
  const series = `/api/v1/runs/${runId}/series/fallback/p0/0`;
  const index: SeriesIndex = await (await request.get(series)).json();
  const payment = "order-service-to-payment-service";
  const windows: components["schemas"]["ConnectionWindowMetrics"][] = [];
  for (const reference of index.parts.filter(part => part.connections.includes(payment))) {
    const number = reference.file.replace(/^part-(\d+)\.json\.gz$/, "$1");
    const part: components["schemas"]["SeriesPart"] = await (await request.get(`${series}/${number}`)).json();
    windows.push(...(part.connections.find(connection => connection.id === payment)?.windows ?? []));
  }
  windows.sort((first, second) => first.startMs - second.startMs);
  const open = windows.findIndex(window => window.startMs >= 20_000 && window.startMs < 40_000 && window.circuitOpenMs > 0);
  const closed = windows.findIndex(window => window.startMs >= 50_000 && window.circuitOpenMs === 0);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(closed).toBeGreaterThan(open);
  const badge = page.getByTestId(`canvas-policies-${payment}`).getByRole("button", { name: "Circuit breaker", exact: true });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.locator('[data-policy="circuitBreaker"]')).toHaveAttribute("open");
  await page.getByRole("button", { name: "Время", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Окно воспроизведения", exact: true });
  const edge = page.locator(`[data-id="${payment}"] .react-flow__edge-path`);
  await slider.fill(String(open));
  await expect(badge).toHaveClass(/policy-badge--active/);
  await expect(edge).toHaveCSS("stroke-dasharray", "6px, 4px");
  await page.screenshot({ path: testInfo.outputPath("checkout-policies-breaker-open-ru.png") });
  await slider.fill(String(closed));
  await expect(badge).not.toHaveClass(/policy-badge--active/);
  await expect(edge).toHaveCSS("stroke-dasharray", "none");
});

test("builds a new model with two clients, request types and a policy using the interface", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1440 });
  const name = `checkout-builder-${randomUUID()}`;
  const path = `${name}/${name}.model.json`;
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Модель", exact: true }).selectOption({ label: "+ Новая модель…" });
    const dialog = page.getByRole("dialog", { name: "Новая модель", exact: true });
    await dialog.getByRole("textbox", { name: "Имя модели", exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Новая модель", exact: true }).click();
    await expect(page.getByTestId("block-node")).toHaveCount(0);
    const palette = page.getByRole("complementary", { name: "Палитра", exact: true });
    await palette.getByRole("button", { name: "Клиент", exact: true }).dblclick();
    await palette.getByRole("button", { name: "Клиент", exact: true }).dblclick();
    await palette.getByRole("button", { name: "Сервис", exact: true }).dblclick();
    await page.locator(".react-flow__controls-fitview").click();
    const service = page.getByTestId("rf__node-service-1");
    for (const id of ["client-1", "client-2"]) {
      await dragConnection(page.getByTestId(`rf__node-${id}`).locator('[data-handleid="out"]'), service.locator('[data-handleid="in"]'));
      await expect(page.getByTestId(`rf__edge-${id}-to-service-1`)).toBeAttached();
    }
    await page.getByTestId("rf__node-client-2").locator(".block-node > strong").click();
    await page.getByRole("radio", { name: "Несколько видов запросов", exact: true }).check();
    const ids = page.getByRole("textbox", { name: "Идентификатор вида запроса", exact: true });
    await ids.first().fill("status"); await ids.first().press("Enter");
    await page.getByRole("button", { name: "Добавить вид запроса", exact: true }).click();
    await ids.nth(1).fill("checkout"); await ids.nth(1).press("Enter");
    await service.locator(".block-node > strong").click();
    const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
    const parameters = inspector.locator(".inspector-parameters");
    if (await parameters.getAttribute("open") === null) await parameters.locator(":scope > summary").click();
    await inspector.getByRole("button", { name: "+ Добавить политику", exact: true }).click();
    await inspector.getByRole("menuitem", { name: "Rate limit", exact: true }).click();
    await expect(inspector.locator('[data-policy="rateLimit"]')).toHaveAttribute("open");
    await expect(page.getByTestId("canvas-policies-service-1")).toBeVisible();
    await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
    for (const [label, value] of [["Повторения", "2"], ["Разогрев", "0s"], ["Измерение", "1s"]]) {
      const field = inspector.getByLabel(label, { exact: true });
      await field.fill(value); await field.press("Enter");
    }
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByText("Несохранённые изменения", { exact: true })).toBeHidden();
    const stored = async (): Promise<ModelFile> => (await readWorkspaceDocument(page.request, `/api/v1/workspace/document?path=${encodeURIComponent(path)}`)).content.model;
    const saved = await stored();
    expect(Object.values(saved.blocks).filter(block => block.type === "client")).toHaveLength(2);
    expect(saved.blocks["client-2"].params.classes).toMatchObject([{ id: "status" }, { id: "checkout" }]);
    expect(saved.blocks["service-1"].params.rateLimit).toBeDefined();
    await page.reload();
    expect(await stored()).toEqual(saved);
    await page.getByTestId("rf__node-client-2").locator(".block-node > strong").click();
    await expect(ids.nth(0)).toHaveValue("status");
    await expect(ids.nth(1)).toHaveValue("checkout");
    await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("checkout-policies-built-clients-ru.png") });
    const completed = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()), { timeout: 120_000 });
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    const summary: RunSummary = await (await completed).json();
    await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
    const entries = summary.variants[0].points[0].aggregate.entries;
    expect(Object.keys(entries.clients).sort()).toEqual(["client-1", "client-2"]);
    expect(Object.keys(entries.classes).sort()).toEqual(["checkout", "default", "status"]);
    expect(entries.clients["client-2"].pooledLatency.all!.statistics.count).toBeGreaterThan(0);
  } finally {
    await cleanupWorkspace(page, resolve("../apps/server/build/e2e-workspace", name));
  }
});
