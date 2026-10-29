import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const experiment = "retry-storm/retry-storm.experiment.json";

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Experiment", { exact: true }).selectOption("retry-storm/retry-storm.experiment.json");
  await expect(page.getByLabel("Experiment")).toHaveValue(experiment);
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    results: [...document.querySelectorAll<HTMLElement>(".results-body, .summary-table, .summary-services table")]
      .some(el => el.scrollWidth > el.clientWidth),
  }))).toEqual({ horizontal: false, vertical: false, results: false });
}

test("Answer and all service metrics fit at 1440 px without editing documents", async ({ page, request }, testInfo) => {
  const modelUrl = "/api/v1/workspace/document?path=retry-storm/retry-storm.model.json";
  const original = await (await request.get(modelUrl)).json();
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toBeHidden();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Answer", exact: true })).toHaveAttribute("aria-selected", "true");
  const table = page.getByRole("table", { name: "Answer", exact: true });
  await expect(table).toBeVisible();
  const insight = page.getByRole("region", { name: "Saturation insight", exact: true });
  await expect(insight.locator(".saturation-insight > p").first()).toContainText("dependency first");
  await expect(insight.locator(".saturation-insight > p").first()).toBeInViewport({ ratio: 1 });
  await noOverflow(page);
  await expect(table.getByRole("row", { name: /Success rate/ })).toBeInViewport({ ratio: 0.2 });
  await page.screenshot({ path: testInfo.outputPath("after-answer.png") });
  await expect(page.getByRole("region", { name: "Estimate", exact: true })).toHaveCount(0);
  await noOverflow(page);
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  for (const disclosure of await page.locator(".summary-services > summary").all()) await disclosure.click();
  for (const service of ["dependency", "gateway", "middle"]) {
    const metrics = page.getByRole("table", { name: `Service metrics: ${service}`, exact: true });
    await expect(metrics).toBeVisible();
    for (const cell of await metrics.getByRole("row", { name: /Admitted amplification/ }).locator("td").all()) {
      await expect(cell).toContainText("×");
      await expect(cell).toContainText("95% CI");
    }
    for (const cell of await metrics.getByRole("row", { name: /Handler utilization/ }).locator("td").all()) await expect(cell).toContainText("%");
  }
  await page.locator(".results-body").evaluate(el => { el.scrollTop = 0; });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("after-comparison.png") });
  expect(await (await request.get(modelUrl)).json()).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("estimate popover preserves diagram height and closes by button, outside click and Escape", async ({ page }, testInfo) => {
  let jobs = 0;
  page.on("request", request => { if (request.url().endsWith("/api/v1/jobs") && request.method() === "POST") jobs += 1; });
  const canvas = page.getByRole("application", { name: "Model canvas", exact: true });
  await page.getByRole("button", { name: "Restore results", exact: true }).click();
  const before = await canvas.boundingBox();
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  const estimate = page.getByRole("region", { name: "Cost estimate", exact: true });
  await expect(estimate).toBeVisible();
  await expect(estimate.getByLabel("Uncompressed size", { exact: true })).toHaveText(/(?:KiB|MiB)$/);
  await expect(estimate.getByLabel("Artifact size", { exact: true })).toHaveText(/(?:KiB|MiB)$/);
  const popover = page.getByRole("banner").getByRole("region", { name: "Estimate", exact: true });
  await expect(popover).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBe(before!.height);
  expect(before!.height).toBeGreaterThan(0);
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("after-estimate.png") });
  await estimate.screenshot({ path: testInfo.outputPath("after-sizes.png") });
  await page.getByRole("button", { name: "Close estimate", exact: true }).click();
  await expect(estimate).toHaveCount(0);
  expect((await canvas.boundingBox())!.height).toBe(before!.height);
  await page.screenshot({ path: testInfo.outputPath("after-estimate-closed.png") });
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  await expect(estimate).toBeVisible();
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await expect(estimate).toHaveCount(0);
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  await expect(estimate).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(estimate).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(jobs).toBe(0);
});

test("failed estimation starts a real run only after explicit confirmation", async ({ page }, testInfo) => {
  let jobs = 0;
  const messages: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/v1/jobs") && request.method() === "POST") jobs += 1; });
  // Simulate an unavailable estimate endpoint; validation and execution use the real backend.
  await page.route("**/api/v1/estimate", route => route.abort("connectionfailed"));
  const run = page.getByRole("button", { name: "Run", exact: true });
  page.once("dialog", async dialog => { messages.push(dialog.message()); await dialog.dismiss(); });
  await run.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(run).toBeEnabled();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("without an estimate");
  expect(jobs).toBe(0);
  await expect(page.getByRole("table", { name: "Answer", exact: true })).toHaveCount(0);
  page.once("dialog", async dialog => { messages.push(dialog.message()); await dialog.accept(); });
  await run.click();
  await expect(page.getByRole("table", { name: "Answer", exact: true })).toBeVisible();
  await expect(page.getByTestId("job-status")).toContainText("COMPLETED");
  expect(messages).toHaveLength(2);
  expect(jobs).toBe(1);
  await expect(page.getByRole("region", { name: "Estimate", exact: true })).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("after-estimate-failure.png") });
});

test("keeps the tab chosen during Run estimation through real execution", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/estimate", async route => { await pending; await route.continue(); });
  const run = page.getByRole("button", { name: "Run", exact: true });
  await run.click();
  await expect(run).toBeDisabled();
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  release();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  await expect(run).toBeEnabled();
  await expect(page.getByRole("tab", { name: "Timeline", exact: true })).toHaveAttribute("aria-selected", "true");
});
