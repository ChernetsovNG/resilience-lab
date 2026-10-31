import { expect, test } from "./fixtures";
import { selectExperiment } from "./fixtures";

test("variant changes navigate to fields and structural gestures explain the Model page", async ({ page }, testInfo) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByTestId("rf__node-gateway")).toBeVisible();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  const banner = page.getByTestId("variant-banner");
  await expect(page.locator(".variant-canvas")).toHaveCSS("outline-color", "rgb(109, 40, 217)");
  await expect(banner.locator("summary")).toHaveText("No retries · Structure is read-only · 2 changes");
  await page.screenshot({ path: testInfo.outputPath("no-retries-before.png") });
  await banner.locator("summary").click();
  await expect(banner.getByRole("button", { name: "middle-to-dependency · Attempts: 3 → 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse inspector", exact: true }).click();
  await banner.getByRole("button", { name: "gateway-to-middle · Attempts: 3 → 1", exact: true }).click();
  await expect(page.getByLabel("Attempts", { exact: true })).toBeFocused();
  await expect(page.getByTestId("canvas-edge-label-gateway-to-middle")).toHaveAttribute("aria-pressed", "true");
  const bannerBox = await banner.boundingBox();
  const gateway = page.getByTestId("rf__node-gateway");
  const nodeBox = await gateway.boundingBox();
  expect(nodeBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height);
  await page.screenshot({ path: testInfo.outputPath("no-retries-changes.png") });

  const position = await gateway.evaluate(node => getComputedStyle(node).transform);
  const title = await gateway.locator("strong").boundingBox();
  await page.mouse.move(title!.x + 10, title!.y + title!.height / 2);
  await page.mouse.down();
  await page.mouse.move(title!.x + 70, title!.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("alert")).toContainText("Structure is edited on the Model page");
  await expect(gateway).toHaveCSS("transform", position);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Model", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Model", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("variant-banner")).toHaveCount(0);
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await banner.locator("summary").click();
  await expect(banner.getByText("Same as model", { exact: true })).toBeVisible();
});

test("variant marks coexist with calculated metric colors", async ({ page }, testInfo) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/COMPLETED/, { exact: false }).first()).toBeVisible();
  await page.getByRole("tab", { name: "No retries", exact: true }).click();
  await expect(page.getByTestId("canvas-results-gateway")).toBeVisible();
  const background = await page.getByTestId("rf__node-gateway").getByTestId("block-node").evaluate(node => node.style.getPropertyValue("--node-fill"));
  expect(background).not.toBe("");
  await expect(page.getByTestId("canvas-edge-label-gateway-to-middle")).toHaveClass(/canvas-edge-label--overridden/);
  await expect(page.getByTestId("canvas-param-gateway-to-middle-attempts").locator("del")).toHaveText("3");
  await page.screenshot({ path: testInfo.outputPath("no-retries-after.png") });
});
