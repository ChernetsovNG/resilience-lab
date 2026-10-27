import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const experiment = "retry-storm/retry-storm.experiment.json";
const model = "retry-storm/retry-storm.model.json";

async function expectNoPageScroll(page: Page) {
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ horizontal: false, vertical: false });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await expect(page.getByLabel("Experiment")).toHaveValue(experiment);
  await expect(page.getByTestId("block-node")).toHaveCount(4);
});

test("shows variant pages read-only with their overrides and edits only on the model page", async ({ page }) => {
  await page.getByRole("tab", { name: "No retries" }).click();
  const call = page.getByTestId("rf__edge-gateway-to-middle");
  await expect(call).toContainText("· 1×");
  await call.click();

  const attempts = page.getByLabel("Attempts", { exact: true });
  await expect(attempts).toHaveValue("1");
  await expect(attempts).not.toBeEditable();
  await expect(page.locator(".param-field--overridden")).toContainText("overridden");

  await page.getByRole("tab", { name: "Baseline" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).not.toBeEditable();

  await page.getByRole("tab", { name: "Model" }).click();
  await expect(attempts).toHaveValue("3");
  await expect(attempts).toBeEditable();
});

test("edits the model, saves it, runs the experiment and shows the summary", async ({ page, request }) => {
  await expectNoPageScroll(page);
  await page.getByTestId("rf__node-gateway").click();
  const handlers = page.getByLabel("Handlers", { exact: true });
  await expect(handlers).toHaveValue("4");
  await handlers.fill("4.5");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await handlers.fill("6");
  await handlers.press("Enter");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  const stored = await (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(model)}`)).json();
  expect(stored.content.model.blocks.gateway.params.handlers).toBe(6);

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });
  const summary = page.getByRole("table", { name: "Summary" });
  await expect(summary.getByRole("row", { name: /Baseline/ })).toContainText("%");
  await expect(summary.getByRole("row", { name: /No retries/ })).toContainText("%");
  await expectNoPageScroll(page);
});
