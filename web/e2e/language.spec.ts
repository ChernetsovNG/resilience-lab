import { selectExperiment } from "./fixtures";
import { expect, test, type Page } from "./fixtures";
import catalogSnapshot from "../src/test/catalog.json" with { type: "json" };

test.use({ locale: "ru-RU", viewport: { width: 1440, height: 900 }, actionTimeout: 10_000 });

test("waits for the initial catalog and loads another language only on demand", async ({ page }) => {
  let releaseRussian!: () => void, releaseEnglish!: () => void;
  const russian = new Promise<void>(resolve => { releaseRussian = resolve; });
  const english = new Promise<void>(resolve => { releaseEnglish = resolve; });
  let russianRequests = 0, englishRequests = 0;
  await page.route("**/src/i18n/ru.json*", async route => { russianRequests++; await russian; await route.continue(); });
  await page.route("**/src/i18n/en.json*", async route => { englishRequests++; await english; await route.continue(); });
  const navigation = page.goto("/");
  try {
    await expect.poll(() => russianRequests).toBe(1);
    await expect(page.locator("#root")).toBeEmpty();
    expect(englishRequests).toBe(0);
    releaseRussian();
    await navigation;
    await page.getByRole("button", { name: "Вид", exact: true }).click();
    await page.getByLabel("Язык", { exact: true }).selectOption("en");
    await expect.poll(() => englishRequests).toBe(1);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeVisible();
    releaseEnglish();
    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    await page.getByLabel("Language", { exact: true }).selectOption("ru");
    await page.getByLabel("Язык", { exact: true }).selectOption("en");
    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    expect(russianRequests).toBe(1);
    expect(englishRequests).toBe(1);
  } finally { releaseRussian(); releaseEnglish(); await navigation; }
});

async function chooseLanguage(page: Page, language: "en" | "ru", current: "en" | "ru") {
  await page.getByRole("button", { name: current === "ru" ? "Вид" : "View", exact: true }).click();
  await page.getByLabel(current === "ru" ? "Язык" : "Language", { exact: true }).selectOption(language);
  await page.getByRole("button", { name: language === "ru" ? "Вид" : "View", exact: true }).click();
}

test("Russian browser gets translated controls, catalog and results; language preserves editing and survives reload", async ({ page, request }, testInfo) => {
  const modelURL = "/api/v1/workspace/document?path=retry-storm/retry-storm.model.json";
  const original = await (await request.get(modelURL)).json();
  expect(await (await request.get("/api/v1/catalog")).json()).toEqual(catalogSnapshot);
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByLabel("Повторения", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Измерение", { exact: true })).toHaveValue("1s");
  await expect(page.getByRole("button", { name: "Приблизить", exact: true })).toBeVisible();

  await page.getByTestId("block-node").filter({ hasText: "gateway" }).click();
  const inspector = page.getByRole("complementary", { name: "Инспектор", exact: true });
  const handlers = inspector.getByLabel("Обработчики", { exact: true });
  const initialHandlers = await handlers.inputValue();
  await expect(inspector.getByRole("group", { name: "Время обработки", exact: true })).toBeVisible();
  await handlers.fill("99");
  await handlers.press("Enter");
  await chooseLanguage(page, "en", "ru");
  await expect(page.getByRole("button", { name: "Zoom In", exact: true })).toBeVisible();
  const englishHandlers = page.getByRole("complementary", { name: "Inspector", exact: true }).getByLabel("Handlers", { exact: true });
  await expect(englishHandlers).toHaveValue("99");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(englishHandlers).toHaveValue(initialHandlers);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(englishHandlers).toHaveValue("99");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await page.reload();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await chooseLanguage(page, "ru", "en");
  await page.getByTestId("block-node").filter({ hasText: "gateway" }).click();
  await expect(inspector.getByRole("option", { name: "Фиксированное", exact: true })).toHaveJSProperty("selected", true);
  await expect(page.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("russian-before-run.png") });

  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  const answer = page.getByRole("table", { name: "Ответ", exact: true });
  await expect(answer).toBeVisible();
  await expect(answer.getByRole("row", { name: /Доля успешных/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Вывод о насыщении", exact: true })).toContainText("dependency");
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await expect(page.getByText("Загрузка рядов элемента…", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("russian-after-run.png") });
  await page.getByRole("tab", { name: "Таймлайн", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Загрузка (%)", exact: true })).toBeVisible();
  await chooseLanguage(page, "en", "ru");
  await expect(page.getByRole("heading", { name: "Utilization (%)", exact: true })).toBeVisible();
  await chooseLanguage(page, "ru", "en");
  await expect(page.getByRole("heading", { name: "Загрузка (%)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Анализ", exact: true }).click();
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await page.getByLabel("Язык", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Язык", { exact: true })).toBeHidden();
  await expect(page.locator(".workspace-panels")).toHaveClass(/workspace-panels--analysis/);
  expect(await (await request.get(modelURL)).json()).toEqual(original);
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
});

test("worker errors follow the explicit UI language instead of the Russian browser locale", async ({ page }) => {
  await page.goto("/");
  await chooseLanguage(page, "en", "ru");
  const message = await page.evaluate(async () => {
    const path = "/src/results/series/workerClient.ts";
    const { WorkerSeriesDecoder } = await import(path);
    const decoder = new WorkerSeriesDecoder();
    try {
      await decoder.decode([JSON.stringify({ schemaVersion: 6, kind: "INSTANCE", profile: "unsupported-test-profile", fromWindow: 0, untilWindow: 1,
        connections: [], nodes: [{ id: "gateway", windows: [{ startMs: 0, durationMs: 10,
          originalArrivals: 0, offeredAttempts: 0, admittedAttempts: 0, successes: 0, failures: 0, timeouts: 0, retries: 0,
          slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: 10,
            waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } },
          latency: { count: 0, sumMs: 0, sketch: [0] },
        }] }],
      })]);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally { decoder.close(); }
    throw new Error("Expected a decoding error");
  });
  expect(message).toBe("Unsupported sketch profile: unsupported-test-profile");
});

test("View remains accessible on narrow screens during a run", async ({ page }) => {
  let hold = true;
  await page.route("**/api/v1/jobs/*", async route => {
    const response = await route.fetch();
    const job = await response.json();
    await route.fulfill({ response, json: hold ? { ...job, status: "RUNNING" } : job });
  });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await page.getByRole("button", { name: "Запустить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Отменить", exact: true })).toBeVisible();
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const view = page.getByRole("button", { name: "Вид", exact: true });
    await expect(view).toBeInViewport({ ratio: 1 });
    await view.press("Enter");
    await expect(page.getByLabel("Язык", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(view).toBeFocused();
  }
  hold = false;
  await expect(page.getByRole("table", { name: "Ответ", exact: true })).toBeVisible();
});

test("an existing canvas notice follows the selected language", async ({ page }) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await chooseLanguage(page, "en", "ru");
  const port = page.getByTestId("rf__node-gateway").locator(".react-flow__handle.source");
  await expect(port).toBeVisible();
  const box = (await port.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y - 80, { steps: 10 });
  await page.mouse.up();
  const notice = page.locator(".canvas-notice");
  await expect(notice).toContainText("Connect an output port");
  await chooseLanguage(page, "ru", "en");
  await expect(notice).not.toContainText("Connect an output port");
  await expect(notice).toContainText("порт");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
});


test("View settings stay open while changing preferences and persist without editing documents", async ({ page, request }) => {
  const modelURL = "/api/v1/workspace/document?path=retry-storm/retry-storm.model.json";
  const original = await (await request.get(modelURL)).json();
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  const menu = page.locator("#view-menu");
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await page.getByLabel("Шаг сетки", { exact: true }).selectOption("40");
  await expect(menu).toBeVisible();
  await expect(page.getByLabel("Шаг сетки", { exact: true })).toHaveValue("40");
  await page.getByLabel("Привязка к сетке", { exact: true }).uncheck();
  await expect(menu).toBeVisible();
  await page.getByLabel("Показывать сетку", { exact: true }).uncheck();
  await expect(menu).toBeVisible();
  await page.getByLabel("Размер текста интерфейса", { exact: true }).selectOption("110");
  await expect(menu).toBeVisible();
  await page.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(menu).toBeVisible();
  await expect(menu.getByLabel("Confidence level", { exact: true })).toHaveCount(0);
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 100 } });
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "View", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  expect(await (await request.get(modelURL)).json()).toEqual(original);

  await page.reload();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByLabel("Grid step", { exact: true })).toHaveValue("40");
  await expect(page.getByLabel("Snap to grid", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Show grid", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Interface text size", { exact: true })).toHaveValue("110");
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(menu.getByLabel("Confidence level", { exact: true })).toHaveCount(0);
  await page.getByLabel("Grid step", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "View", exact: true })).toBeFocused();
});
