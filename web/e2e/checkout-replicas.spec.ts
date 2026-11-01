import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelFile, RunSummary } from "../src/api/apiTypes";
import { expect, test, type Locator, type Page } from "./fixtures";
import { dragConnection, dragNode } from "./canvasGestures";

test.use({ viewport: { width: 1920, height: 1100 }, actionTimeout: 10_000 });

async function openSection(section: Locator) {
  if (!await section.evaluate(element => (element as HTMLDetailsElement).open))
    await section.locator(":scope > summary").click();
}

async function field(page: Page, path: string, value: string) {
  const input = page.getByRole("complementary", { name: "Инспектор", exact: true })
    .locator(`[data-inspector-field="${path}"]`).getByRole("textbox");
  await input.fill(value);
  await input.press("Tab");
}

async function choice(page: Page, path: string, value: string) {
  await page.getByRole("complementary", { name: "Инспектор", exact: true })
    .locator(`[data-inspector-field="${path}"]`).getByRole("combobox").selectOption(value);
}

async function selectNode(page: Page, id: string) {
  await page.getByTestId(`rf__node-${id}`).locator(".block-node > strong").click();
  await openSection(page.locator(".inspector-parameters"));
}

async function selectConnection(page: Page, id: string) {
  await page.getByTestId(`canvas-edge-label-${id}`).click();
  await openSection(page.locator(".inspector-parameters"));
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Несохранённые изменения", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
}

function semanticModel(model: ModelFile) {
  return JSON.parse(JSON.stringify({ ...model, connections: [...model.connections].sort((a, b) => a.id.localeCompare(b.id)) },
    (key, value) => key === "notes" || key === "description" ? undefined : value));
}

test("builds checkout-replicas from the palette, saves the example and exposes the degraded replica pool in Russian", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("resilience-lab.language", "ru"));
  const directory = `checkout-replicas-${randomUUID()}`;
  const relative = `${directory}/checkout-replicas`;
  const root = resolve("../apps/server/build/e2e-workspace", relative);
  try {
    await page.goto("/");
    await expect(page.getByTestId("block-node").first()).toBeVisible();
    await page.getByRole("button", { name: "Файл", exact: true }).click();
    await page.getByRole("button", { name: "Новая модель", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Новая модель", exact: true });
    await dialog.getByLabel("Имя модели", { exact: true }).fill(relative);
    await dialog.getByRole("button", { name: "Новая модель", exact: true }).click();
    await expect(page.getByTestId("block-node")).toHaveCount(0);
    const collapse = page.getByRole("button", { name: "Свернуть результаты", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    const palette = page.getByRole("complementary", { name: "Палитра", exact: true });
    const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });

    await test.step("Add and configure every block using the palette and inspector", async () => {
      let blockCount = 0;
      for (const [type, id] of [
        ["Клиент", "mobile-app"], ["Сервис", "api-gateway"], ["Сервис", "order-service"],
        ["Пулер соединений", "pgbouncer"], ["База данных", "orders-db"],
        ["Сервис", "payment-service"], ["Сервис", "psp"],
      ]) {
        await palette.getByRole("button", { name: type, exact: true }).dblclick();
        await expect(page.getByTestId("block-node")).toHaveCount(++blockCount);
        await page.locator(".react-flow__controls-fitview").click();
        const created = type === "Клиент" ? "client-1" : type === "Сервис" ? "service-1" : type === "База данных" ? "database-1" : "pooler-1";
        await selectNode(page, created);
        await expect(inspector.getByRole("heading", { name: created, exact: true })).toBeVisible();
        await openSection(page.locator(".inspector-parameters"));
        const identifier = inspector.getByLabel("Идентификатор", { exact: true });
        await identifier.fill(id);
        await identifier.press("Tab");
        await expect(page.getByTestId(`rf__node-${id}`)).toBeAttached();
        if (id === "mobile-app") {
          await field(page, "deadline", "2s");
          await openSection(page.locator(".inspector-load"));
          await field(page, "load.points.0.rate", "120/s");
        } else {
          if (id === "pgbouncer") {
            await field(page, "maxClientConnections", "1000");
            await field(page, "poolSize", "20");
            await field(page, "waitTimeout", "100ms");
          } else if (id === "orders-db") {
            await field(page, "maxConnections", "100");
            await field(page, "queue", "100");
          } else {
            await field(page, "handlers", "200");
            await field(page, "queue", "100");
            if (id === "order-service") await field(page, "replicas", "3");
          }
          await choice(page, "processing.kind", id === "psp" ? "lognormal" : "fixed");
          await field(page, "processing.mean", id === "psp" ? "300ms" : id === "pgbouncer" ? "0.1ms" : id === "orders-db" ? "5ms" : "2ms");
          if (id === "psp") await field(page, "processing.stdDev", "150ms");
          if (id !== "pgbouncer") await field(page, "failureRate", "0%");
        }
      }
      await expect(page.getByTestId("block-node")).toHaveCount(7);
      if (await collapse.isVisible()) await collapse.click();
      await page.locator(".react-flow__controls-fitview").click();
      for (let zoom = 0; zoom < 4; zoom++) await page.locator(".react-flow__controls-zoomout").click();
      await page.getByTestId("rf__node-mobile-app").click({ trial: true });
      // Arrange both branches with mouse drags; the saved layout comes from the editor too.
      for (const [id, x, y] of [
        ["mobile-app", 0.08, 0.3], ["api-gateway", 0.28, 0.3], ["order-service", 0.48, 0.3],
        ["pgbouncer", 0.7, 0.15], ["orders-db", 0.9, 0.15],
        ["payment-service", 0.7, 0.45], ["psp", 0.9, 0.45],
      ] as const) {
        await page.getByTestId(`rf__node-${id}`).click({ trial: true });
        await dragNode(page.getByTestId(`rf__node-${id}`), (header, canvas) => ({
          x: canvas.x + canvas.width * x - header.x - header.width / 2,
          y: canvas.y + canvas.height * y - header.y - header.height / 2,
        }));
      }
      await page.locator(".react-flow__controls-fitview").click();
    });

    await test.step("Connect the graph, set per-replica pool and repeated DB calls", async () => {
      for (const [from, to] of [
        ["mobile-app", "api-gateway"], ["api-gateway", "order-service"],
        ["order-service", "pgbouncer"], ["pgbouncer", "orders-db"],
        ["order-service", "payment-service"], ["payment-service", "psp"],
      ]) {
        await page.locator(".react-flow__controls-fitview").click();
        await dragConnection(page.getByTestId(`rf__node-${from}`).locator('[data-handleid="out"]'),
          page.getByTestId(`rf__node-${to}`).locator('[data-handleid="in"]'));
        await expect(page.getByTestId(`rf__edge-${from}-to-${to}`)).toBeAttached();
        if (from === "mobile-app") continue;
        await selectConnection(page, `${from}-to-${to}`);
        await field(page, "network.mean", "0.5ms");
        await field(page, "timeout", from === "api-gateway" ? "800ms" : to === "pgbouncer" ? "350ms" : to === "orders-db" ? "100ms" : "1s");
        if (from === "api-gateway") {
          await field(page, "attempts", "3");
          await choice(page, "balancing", "roundRobin");
          await choice(page, "retryTarget", "any");
          await choice(page, "backoff.kind", "fixed");
          await field(page, "backoff.base", "100ms");
          await field(page, "backoff.max", "100ms");
        }
        if (to === "pgbouncer") {
          await inspector.getByRole("button", { name: "Включить: Пул соединений", exact: true }).click();
          await field(page, "pool.size", "10");
          await field(page, "pool.acquireTimeout", "100ms");
        }
      }
      await selectNode(page, "order-service");
      const scenario = page.locator(".inspector-scenario");
      await openSection(scenario);
      await scenario.getByRole("button", { name: "Задать свой сценарий", exact: true }).click();
      const steps = scenario.locator(".scenario-step");
      await steps.nth(1).getByRole("combobox", { name: "Связь", exact: true }).selectOption("order-service-to-pgbouncer");
      await steps.nth(2).getByRole("combobox", { name: "Связь", exact: true }).selectOption("order-service-to-payment-service");
      await scenario.getByRole("button", { name: "Добавить вызов", exact: true }).click();
      await steps.nth(3).getByRole("combobox", { name: "Связь", exact: true }).selectOption("order-service-to-pgbouncer");
    });

    await test.step("Create the replica connection fault and all five experiment variants", async () => {
      await selectConnection(page, "order-service-to-pgbouncer");
      await inspector.getByRole("combobox", { name: "Цель отказа", exact: true }).selectOption("order-service-to-pgbouncer#2");
      await inspector.getByRole("button", { name: "Добавить отказ", exact: true }).click();
      await field(page, "faults.0.from", "20s");
      await field(page, "faults.0.to", "40s");
      await field(page, "faults.0.multiplier", "");
      await field(page, "faults.0.delay", "200ms");
      await field(page, "execution.seed", "20261031");
      await field(page, "execution.window", "100ms");
      for (const [id, label, path, value] of [
        ["other-replica", "Другая реплика", "retryTarget", "other"],
        ["least-in-flight", "Меньше активных вызовов", "balancing", "leastInFlight"],
        ["bigger-pool", "Пул 20", "pool.size", "20"],
        ["no-backoff", "Повторы без паузы", "backoff.kind", "none"],
      ]) {
        await page.getByRole("button", { name: "Добавить вариант", exact: true }).click();
        await field(page, "variant.id", id);
        await field(page, "variant.label", label);
        await selectConnection(page, path === "pool.size" ? "order-service-to-pgbouncer" : "api-gateway-to-order-service");
        if (path === "pool.size") await field(page, path, value);
        else await choice(page, path, value);
      }
      await save(page);
    });

    // Capture the canonical files saved by the UI before shortening the experiment.
    for (const kind of ["model", "layout", "experiment"]) {
      const name = `checkout-replicas.${kind}.json`;
      await writeFile(testInfo.outputPath(name), await readFile(resolve(root, name)));
    }
    const saved: ModelFile = JSON.parse(await readFile(resolve(root, "checkout-replicas.model.json"), "utf8"));
    const example: ModelFile = JSON.parse(await readFile(resolve("../examples/checkout-replicas/checkout-replicas.model.json"), "utf8"));
    expect(semanticModel(saved)).toEqual(semanticModel(example));
    await page.reload();
    await expect(page.getByTestId("rf__node-order-service").locator(".block-replica-count")).toHaveText("×3");
    await page.getByRole("button", { name: "Настройки прогона", exact: true }).click();
    await field(page, "faults.0.from", "2s");
    await field(page, "faults.0.to", "4s");
    await field(page, "execution.warmup", "1s");
    await field(page, "execution.measurement", "4s");
    await field(page, "execution.replications", "2");
    await save(page);
    const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
    await page.getByRole("button", { name: "Запустить", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    await expect(page.getByTestId("job-status")).toHaveText("ЗАВЕРШЕНО");
    const baseline = summary.variants.find(variant => variant.id === "baseline")!.points[0];
    expect(baseline.saturation.firstNodes).toContainEqual(expect.objectContaining({ node: "order-service-to-pgbouncer#2", slotPool: "pool" }));
    await page.getByRole("tab", { name: "Базовый", exact: true }).click();
    await page.locator(".react-flow__controls-fitview").click();
    await expect(page.getByTestId("canvas-results-order-service")).toContainText(/худшая #\d/);
    await page.mouse.move(700, 80);
    await page.screenshot({ path: testInfo.outputPath("checkout-replicas-canvas-ru.png") });
    await page.getByTestId("rf__node-order-service").locator(".block-node > strong").click();
    const replicas = inspector.getByRole("table", { name: "Реплики · order-service", exact: true });
    await expect(replicas.getByRole("row")).toHaveCount(4);
    await expect(replicas.getByRole("button", { name: "order-service#2", exact: true })).toBeVisible();
    await inspector.screenshot({ path: testInfo.outputPath("checkout-replicas-inspector-ru.png") });
    await page.getByRole("tab", { name: "Выводы", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("order-service#2");
    await expect(page.getByRole("tabpanel")).toContainText("pgbouncer");
    await page.getByRole("tabpanel").screenshot({ path: testInfo.outputPath("checkout-replicas-findings-ru.png") });
  } finally {
    await rm(resolve("../apps/server/build/e2e-workspace", directory), { recursive: true, force: true });
  }
});
