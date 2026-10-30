import { expect, test, type Page } from "@playwright/test";
import { copySmallExperiment } from "./fixtures";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function expectDesktopLayout(page: Page, minimumCanvasHeight = 140) {
  expect(await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }))).toEqual({ x: false, y: false });
  for (const selector of [".top-bar", ".results-context-bar", ".status-bar"]) {
    const bar = page.locator(selector);
    expect(await bar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await bar.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    expect(await bar.evaluate(element => {
      const controls = [...element.querySelectorAll("button, select, input")].map(control => ({
        name: control.getAttribute("aria-label") ?? control.textContent,
        rect: control.getBoundingClientRect(),
      })).filter(({ rect }) => rect.width > 0 && rect.height > 0);
      return controls.flatMap((a, index) => controls.slice(index + 1).flatMap(b =>
        Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x) > 0.5 &&
        Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.y, b.rect.y) > 0.5 ? [[a.name, b.name]] : []));
    })).toEqual([]);
    const box = (await bar.boundingBox())!;
    for (const control of await bar.locator("button, select, input").all()) {
      if (!await control.isVisible()) continue;
      const rect = (await control.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height + 1);
    }
  }
  const canvas = (await page.getByRole("application", { name: "Model canvas", exact: true }).boundingBox())!;
  expect(canvas.width).toBeGreaterThanOrEqual(480);
  expect(canvas.height).toBeGreaterThanOrEqual(minimumCanvasHeight);
}

test("long document, variant and backend labels fit supported desktop widths", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/responsive-labels");
  const name = "retry-storm-with-a-long-experiment-path-for-inspecting-desktop-layout-and-browser-zoom.experiment.json";
  const path = `responsive-labels/${name}`;
  const label = "Baseline with a long descriptive label for the selected experiment variant ".repeat(4).trim();
  await mkdir(directory);
  try {
    const experiment = await copySmallExperiment(directory, name);
    experiment.variants[0].label = label;
    experiment.grid = [{ path: "gateway.handlers", values: [4] }];
    await writeFile(resolve(directory, name), JSON.stringify(experiment));
    await page.route("**/api/v1/health", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), applicationVersion: "development-version-".repeat(20), kslVersion: "snapshot-version-".repeat(20) } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByLabel("Experiment", { exact: true }).selectOption(path);
    await expect(page.getByLabel("Experiment", { exact: true })).toHaveAttribute("title", path);
    await page.getByRole("tab", { name: label, exact: true }).click();
    const run = page.getByRole("button", { name: "Run", exact: true });
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    await page.getByRole("button", { name: "Time", exact: true }).click();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByRole("region", { name: "Latency", exact: true })).toBeVisible();
    await expect(page.locator(".results-context-variant")).toHaveAttribute("title", label);
    await expect(page.locator(".status-backend .health-badge")).toHaveAttribute("title", /development-version-/);
    // 1440×900 at 150% browser zoom has a 960×600 CSS viewport.
    await page.setViewportSize({ width: 960, height: 600 });
    await page.getByRole("separator", { name: "Resize inspector", exact: true }).press("End");
    await page.getByTestId("rf__node-dependency").click();
    const handlers = page.getByLabel("Handlers", { exact: true });
    await page.locator(".inspector-parameters > summary").click();
    await handlers.fill("3"); await handlers.press("Enter");
    await expect(page.locator(".results-context-bar .canvas-results-stale")).toBeVisible();
    await expectDesktopLayout(page, 80);
    for (const [width, height] of [[1280, 720], [2560, 1440], [3840, 2160]]) {
      await page.setViewportSize({ width, height });
      await expectDesktopLayout(page);
      const columns = await page.locator(".timeline-charts").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(width === 1280 ? 2 : 3);
      if (width === 2560) await page.screenshot({ path: testInfo.outputPath("long-labels-2560.png") });
    }
    const grid = page.locator(".timeline-charts");
    for (const [width, columns] of [[700, 1], [1000, 2], [1600, 3]]) {
      await grid.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
      await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(columns);
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
  test(`example, Run, Answer, Time and Timeline at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    const directory = resolve(`../apps/server/build/e2e-workspace/responsive-${viewport.width}`);
    await mkdir(directory);
    try {
      await copySmallExperiment(directory);
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.getByLabel("Experiment", { exact: true }).selectOption(`responsive-${viewport.width}/retry-storm.experiment.json`);
      await expect(page.getByText("Shared by all variants", { exact: true })).toHaveCount(1);
      await page.getByRole("tab", { name: "Baseline", exact: true }).click();
      const run = page.getByRole("button", { name: "Run", exact: true });
      await expect(run).toBeEnabled();
      await run.click();
      await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
      await expect(page.getByRole("table", { name: "Answer", exact: true })).toBeVisible();
      await expectDesktopLayout(page);
      await page.screenshot({ path: testInfo.outputPath(`answer-${viewport.width}.png`) });

      await page.getByRole("button", { name: "Time", exact: true }).click();
      await expect(page.getByRole("slider", { name: "Playback window", exact: true })).toHaveValue("0");
      await page.getByTestId("rf__node-dependency").click();
      await page.getByRole("tab", { name: "Timeline", exact: true }).click();
      await expect(page.getByRole("region", { name: "Latency", exact: true })).toBeVisible();
      await expectDesktopLayout(page);
      await page.screenshot({ path: testInfo.outputPath(`timeline-${viewport.width}.png`) });

      const divider = page.getByRole("separator", { name: "Resize inspector", exact: true });
      const initialWidth = Number(await divider.getAttribute("aria-valuenow"));
      const boundary = (await divider.boundingBox())!;
      await page.mouse.move(boundary.x + boundary.width / 2, boundary.y + boundary.height / 2);
      await page.mouse.down();
      await page.mouse.move(boundary.x + boundary.width / 2 - 48, boundary.y + boundary.height / 2);
      await page.mouse.up();
      expect(Number(await divider.getAttribute("aria-valuenow"))).toBe(Math.min(480, initialWidth + 48));
      await divider.dblclick();
      await divider.press("End");
      expect(Number(await divider.getAttribute("aria-valuenow"))).toBe(480);
      await divider.dblclick();
      expect(Number(await divider.getAttribute("aria-valuenow"))).toBe(initialWidth);
      await page.getByRole("button", { name: "Collapse inspector", exact: true }).click();
      await page.getByTestId("rf__node-gateway").click();
      await expect(page.getByRole("button", { name: "Expand inspector: gateway selected", exact: true })).toBeVisible();
      await expect(page.locator(".inspector-content")).toBeHidden();
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await page.reload();
      await expect(page.getByRole("button", { name: "Expand inspector", exact: true })).toBeVisible();
    } finally {
      await rm(directory, { recursive: true });
    }
  });
}
