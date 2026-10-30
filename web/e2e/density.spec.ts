import { selectExperiment } from "./fixtures";
import { expect, test } from "@playwright/test";

test("service parameters stay together at the same node height in English and Russian", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const node = page.getByTestId("rf__node-gateway").locator(".block-node");
  const height = () => node.evaluate(element => (element as HTMLElement).offsetHeight);
  const englishHeight = await height();
  await page.screenshot({ path: testInfo.outputPath("parameters-en.png") });
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("ru");
  await page.getByRole("button", { name: "Вид", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("parameters-ru.png") });
  await page.locator(".palette").screenshot({ path: testInfo.outputPath("palette-ru.png") });
  expect(await height()).toBe(englishHeight);
  const pairs = node.locator(".block-summary > span");
  await expect(pairs).toHaveCount(3);
  for (const pair of await pairs.all()) {
    expect(await pair.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    await expect(pair).not.toContainText("·");
  }
  const router = page.getByRole("button", { name: "Маршрутизатор", exact: true });
  await expect(router.locator("svg")).toHaveAttribute("stroke", "currentColor");
  await page.getByTestId("canvas-param-gateway-handlers").dblclick();
  const input = node.getByRole("textbox", { name: "Обработчики", exact: true });
  const inputBox = (await input.boundingBox())!;
  const nodeBox = (await node.boundingBox())!;
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(nodeBox.x + nodeBox.width);
  expect(await height()).toBe(englishHeight);
  await input.fill("2147483647");
  await input.press("Enter");
  await expect(page.getByTestId("canvas-param-gateway-handlers")).toHaveText(/2\s147\s483\s647/);
  expect.soft(await node.evaluate(element => [...element.querySelectorAll(".inline-param-value")]
    .every(value => value.getBoundingClientRect().right <= element.getBoundingClientRect().right))).toBe(true);
  await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
  await expect(page.getByTestId("canvas-param-gateway-handlers")).toHaveText("4");
  await page.getByRole("button", { name: "Сервис", exact: true }).click();
  const added = page.locator(".react-flow__node.selected .block-node");
  await expect(added.locator(".block-summary")).toHaveText("обработчики: 200очередь: 100среднее: 10ms");
  expect(await added.evaluate(element => [...element.querySelectorAll(".inline-param-value")]
    .every(value => value.getBoundingClientRect().right <= element.getBoundingClientRect().right))).toBe(true);
});

test("compact inspector and canvas overlays give the model more space", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const canvas = page.getByRole("application", { name: "Model canvas", exact: true });
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(740);
  const inspector = page.locator(".inspector");
  expect(await page.locator(".inspector-content").evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  expect(await inspector.evaluate(element => getComputedStyle(element).fontSize)).toBe("13px");
  expect(await inspector.locator(".inspector-type").evaluate(element => getComputedStyle(element).fontSize)).toBe("12px");
  expect(await inspector.getByLabel("Replications", { exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBe(26);
  expect(await inspector.getByLabel("Replications", { exact: true }).evaluate(element => getComputedStyle(element.parentElement!).fontSize)).toBe("12px");
  const navigation = page.getByRole("group", { name: "Canvas navigation", exact: true });
  await expect(navigation).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  for (const control of await navigation.locator("button, .react-flow__minimap").all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.y).toBeGreaterThanOrEqual(bounds.y);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  const before = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  await expect(page.locator(".react-flow__viewport")).not.toHaveAttribute("style", before!);
  const faults = inspector.locator("details").filter({ has: page.getByText("Faults", { exact: true }) });
  await faults.locator(":scope > summary").click();
  await expect(faults).not.toHaveAttribute("open");
  await page.reload();
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(faults).not.toHaveAttribute("open");
  await expect(inspector.getByLabel("Replications", { exact: true })).toBeVisible();
});

test("large queue values keep the node height and expose their full text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/v1/runs/*/summary", async route => {
    const response = await route.fetch();
    const summary = await response.json();
    for (const variant of summary.variants) {
      for (const point of variant.points) {
        const totals = point.aggregate.services.gateway.totals;
        totals.queueLengthIntegralMs = (variant.id === "baseline" ? 0 : 9_999_999.99) * totals.measurementMs;
      }
    }
    await route.fulfill({ response, json: summary });
  });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  const metrics = page.getByTestId("canvas-results-gateway");
  await expect(metrics).toContainText("Mean queue 0");
  const node = page.getByTestId("rf__node-gateway").locator(".block-node");
  const height = () => node.evaluate(element => element.getBoundingClientRect().height /
    new DOMMatrixReadOnly(getComputedStyle(element.closest(".react-flow__viewport")!).transform).a);
  const zeroHeight = await height();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  const queue = metrics.locator("span").filter({ hasText: "Mean queue 9,999,999.99" });
  await expect(queue).toBeVisible();
  await expect(queue).toHaveAttribute("title", /Mean queue 9,999,999\.99/);
  expect(await height()).toBeCloseTo(zeroHeight, 1);
  expect(await queue.evaluate(element => ({
    ellipsis: getComputedStyle(element).textOverflow,
    wrap: getComputedStyle(element).whiteSpace,
  }))).toEqual({ ellipsis: "ellipsis", wrap: "nowrap" });
});
