import { selectExperiment } from "./fixtures";
import { expect, test } from "@playwright/test";

test("keeps status in one place and reveals warnings and new errors without page scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  const run = page.getByRole("button", { name: "Run", exact: true });
  await expect(run).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("status-initial.png") });

  const status = page.getByRole("region", { name: "Status bar" });
  await expect(status).toBeVisible();
  const zoom = status.getByText(/^Zoom /);
  const initialZoom = await zoom.textContent();
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  await expect(zoom).not.toHaveText(initialZoom!);
  await expect(status.getByRole("button", { name: "Errors: 0 · Warnings: 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Answer", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeHidden();
  await status.getByRole("button", { name: "Errors: 0 · Warnings: 1" }).click();
  await expect(page.getByRole("tab", { name: "Problems", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("LINT_TIMEOUT_BUDGET");
  await page.screenshot({ path: testInfo.outputPath("status-problems.png") });

  await page.getByRole("tab", { name: "Answer", exact: true }).click();
  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await handlers.fill("0");
  await handlers.press("Enter");
  await expect(page.getByRole("tab", { name: "Problems", exact: true })).toHaveAttribute("aria-selected", "true");
  const finding = page.getByRole("tabpanel").getByRole("button", { name: /PARAM_RANGE/ }).first();
  await expect(finding).toBeVisible();
  await expect(finding).toContainText("gateway");
  await expect(finding).toHaveAttribute("title", /\/blocks\/gateway\/params\/handlers/);
  await expect(finding).not.toContainText("/blocks/gateway/params/handlers");
  await finding.click();
  await expect(page.getByRole("heading", { name: "gateway", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("status-error.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(run).toBeEnabled();
  await page.getByRole("tab", { name: "Answer", exact: true }).click();
  await run.click();
  await expect(status.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
  await expect(page.getByText("COMPLETED", { exact: true })).toHaveCount(1);
  await expect(page.locator(".top-bar")).not.toContainText("Backend");
  await expect(page.getByRole("table", { name: "Answer", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("status-completed.png") });
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await expect(status).toBeVisible();
  expect(await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }))).toEqual({ x: false, y: false });
});
