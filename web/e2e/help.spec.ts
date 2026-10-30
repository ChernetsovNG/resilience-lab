import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectExperiment } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
});

async function withinViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

test("reads service and connection help from the real catalog without editing documents", async ({ page, request }, testInfo) => {
  const catalog = await (await request.get("/api/v1/catalog")).json();
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
  const serviceHelp = inspector.getByRole("button", { name: "Help: Service", exact: true });
  await serviceHelp.click();
  const dialog = page.getByRole("dialog", { name: "Service", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(catalog.types.find((type: { id: string }) => type.id === "service").description);
  await expect(dialog.getByRole("rowheader", { name: "Handlers", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Assumptions", exact: true })).toBeVisible();
  await withinViewport(page, dialog);
  await page.screenshot({ path: testInfo.outputPath("service-help.png") });
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("block-node")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(serviceHelp).toBeFocused();

  const field = inspector.getByRole("textbox", { name: "Handlers", exact: true });
  await expect(field.locator("..").locator("p.param-description")).toHaveCount(0);
  const hint = inspector.getByRole("button", { name: "More about: Handlers", exact: true });
  await hint.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Concurrent handlers");
  await withinViewport(page, tooltip);
  await hint.focus();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await hint.click();
  await expect(tooltip).toBeVisible();
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await expect(tooltip).toBeHidden();

  await page.getByTestId("canvas-edge-label-gateway-to-middle").click();
  await inspector.getByRole("button", { name: "Help: Call", exact: true }).click();
  const connection = page.getByRole("dialog", { name: "Call", exact: true });
  await expect(connection).toBeVisible();
  await expect(connection.getByRole("rowheader", { name: "Timeout", exact: true })).toBeVisible();
  await expect(connection.getByRole("rowheader", { name: "Base delay", exact: true })).toHaveCount(1);
  await expect(connection).toContainText("Sent attempts");
  await expect(connection).toContainText("Orphaned");
  await withinViewport(page, connection);
  await page.screenshot({ path: testInfo.outputPath("connection-help.png") });
  await connection.getByRole("button", { name: "Close help", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("Estimate help escapes the scrolling popover and keeps Escape local", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Estimate", exact: true }).click();
  const estimate = page.getByRole("region", { name: "Cost estimate", exact: true });
  await expect(estimate).toBeVisible();
  const help = estimate.getByRole("button", { name: "More about: Tasks", exact: true });
  await help.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("variant × grid point × replication");
  await withinViewport(page, tooltip);
  await page.screenshot({ path: testInfo.outputPath("estimate-help.png") });
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(estimate).toBeVisible();
  await expect(help).toBeFocused();
  await help.press("Enter");
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(estimate).toHaveCount(0);
});
