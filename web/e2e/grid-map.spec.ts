import { cleanupWorkspace, expect, test, type Page } from "./fixtures";
import { selectExperiment, copySmallExperiment } from "./fixtures";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunSummary } from "../src/api/apiTypes";
import { formatNumber, formatPercent } from "../src/i18n/format";

async function commit(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press("Enter");
}

async function settings(page: Page) {
  await page.getByRole("button", { name: "Run settings", exact: true }).click();
}

async function saveAndRun(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const response = page.waitForResponse((response) => /\/runs\/[^/]+\/summary$/.test(response.url()));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const result = await response;
  return { runId: /\/runs\/([^/]+)\/summary$/.exec(result.url())![1], summary: await result.json() as RunSummary };
}

test("stage 1: edit a variant and timeout × attempts, inspect Map, Timeline, playback and the saturation insight", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const directory = resolve("../apps/server/build/e2e-workspace/grid-map");
  const names = ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"];
  await mkdir(directory);
  try {
    await copySmallExperiment(directory, "retry-storm.experiment.json", "10ms");
    const documents = () => Promise.all(names.map(async (name) =>
      (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`grid-map/${name}`)}`)).json()));
    await page.goto("/");
    await selectExperiment(page, "grid-map/retry-storm.experiment.json");
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await page.getByTestId("rf__node-gateway").locator(".block-node > strong").click();
    await commit(page, "Handlers", "6");
    await settings(page);
    await page.getByRole("button", { name: "Add grid axis", exact: true }).click();
    await page.getByRole("combobox", { name: "Axis 1 parameter", exact: true }).selectOption("gateway-to-middle.timeout");
    await page.getByRole("button", { name: "Add value to axis 1", exact: true }).click();
    await commit(page, "Axis 1 value 1", "20ms");
    await commit(page, "Axis 1 value 2", "80ms");
    await page.getByRole("button", { name: "Add grid axis", exact: true }).click();
    await page.getByRole("combobox", { name: "Axis 2 parameter", exact: true }).selectOption("gateway-to-middle.attempts");
    await page.getByRole("button", { name: "Add value to axis 2", exact: true }).click();
    await commit(page, "Axis 2 value 1", "1");
    await commit(page, "Axis 2 value 2", "3");
    await expect(page.getByRole("button", { name: "Add grid axis", exact: true })).toBeDisabled();
    expect(await page.getByRole("complementary", { name: "Inspector" }).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("grid-editor.png") });
    const result = await saveAndRun(page);
    expect(result.summary.grid).toEqual([
      { path: "gateway-to-middle.timeout", values: ["20ms", "80ms"] },
      { path: "gateway-to-middle.attempts", values: [1, 3] },
    ]);
    const savedDocuments = await documents();
    expect(savedDocuments[0].content.experiment.variants[0].overrides).toEqual({ "gateway.handlers": 6 });

    await page.getByRole("tab", { name: "Map", exact: true }).click();
    const heatmap = page.getByRole("table", { name: "Parameter heatmap" });
    await expect(heatmap.getByRole("button")).toHaveCount(4);
    const point = result.summary.variants.find((variant) => variant.id === "baseline")!.points.find((point) => point.id === "p3")!;
    await expect(heatmap.getByRole("button").nth(3)).toContainText(formatPercent(point.aggregate.entries.total.successRate!.mean));
    const series = page.waitForResponse((response) => response.url().includes(`/series/baseline/p3/0`));
    await heatmap.getByRole("button").nth(3).click();
    await expect(heatmap.getByRole("button").nth(3)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Timeout · gateway → middle = 80 ms/);
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Attempts · gateway → middle = 3/);
    const dependency = point.aggregate.services.dependency.totals;
    await expect(page.getByTestId("canvas-results-dependency")).toContainText(`Queue ${formatNumber(dependency.slotPools.handlers.queueIntegralMs / dependency.measurementMs)}`);
    await page.getByRole("combobox", { name: "Map metric", exact: true }).selectOption("handlerUtilization");
    await page.getByRole("combobox", { name: "Element on map", exact: true }).selectOption("dependency");
    await expect(heatmap.getByRole("button").nth(3)).toContainText(formatPercent(dependency.slotPools.handlers.busyIntegralMs / dependency.slotPools.handlers.capacityIntegralMs));
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("heatmap.png") });
    await page.getByRole("button", { name: "Analysis", exact: true }).click();

    await page.getByRole("tab", { name: "Findings", exact: true }).click();
    const insight = page.getByRole("region", { name: "Saturation insight" });
    await expect(insight.getByRole("heading")).toContainText("Baseline · ");
    await expect(insight.getByRole("heading")).toContainText("Timeout · gateway → middle = 80 ms");
    await expect(insight.getByRole("heading")).toContainText("Attempts · gateway → middle = 3");
    await expect(insight.getByRole("heading")).not.toContainText("p3");
    await expect(page.getByLabel("Grid point", { exact: true })).toHaveValue("p3");
    await expect(page.getByLabel("Grid point", { exact: true }).locator("option:checked")).toContainText("Timeout · gateway → middle = 80 ms");
    await expect(insight).toContainText("How saturation is detected");
    await expect(page.getByRole("table", { name: "Findings", exact: true }).getByRole("row", { name: /Success rate/ }).locator("td").first()).toContainText(formatPercent(point.aggregate.entries.total.successRate!.mean));
    await page.getByRole("button", { name: /fit view/i }).click();
    await page.getByTestId("rf__node-dependency").locator(".block-node > strong").click();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    expect((await series).ok()).toBe(true);
    await expect(page.getByLabel("Grid point", { exact: true })).toHaveValue("p3");
    await expect(page.getByText("Loading series…", { exact: true })).toBeHidden();
    const slider = page.getByRole("region", { name: "Queue", exact: true }).getByRole("slider");
    await slider.focus();
    await slider.press("Home");
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Window 0/);
    expect(await page.getByRole("region", { name: "Results context" }).evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
    await expect(page.getByTestId("canvas-results-dependency")).toBeVisible();
    const frame = await page.getByTestId("canvas-results-dependency").locator("span").allTextContents();
    await page.getByRole("button", { name: "Next window", exact: true }).click();
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window 1");
    await page.getByRole("button", { name: "Previous window", exact: true }).click();
    await expect(page.getByTestId("canvas-results-dependency").locator("span")).toHaveText(frame);
    await page.getByLabel("Playback speed", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Play run", exact: true }).click();
    await expect.poll(async () => Number(await page.getByRole("slider", { name: "Playback window", exact: true }).inputValue())).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause run", exact: true }).click();
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await heatmap.getByRole("button").nth(0).click();
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Timeout · gateway → middle = 20 ms/);
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Attempts · gateway → middle = 1/);
    await page.getByRole("button", { name: "Summary", exact: true }).click();
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Summary · Baseline ·/);
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Timeout · gateway → middle = 20 ms/);
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Attempts · gateway → middle = 1/);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(await documents()).toEqual(savedDocuments);

    await settings(page);
    await page.getByRole("button", { name: "Remove grid axis 2", exact: true }).click();
    await page.getByRole("button", { name: "Add value to axis 1", exact: true }).click();
    await commit(page, "Axis 1 value 3", "20ms");
    await saveAndRun(page);
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await expect(page.getByRole("table", { name: "Parameter heatmap" })).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Parameter line with 95% confidence intervals" })).toBeVisible();
    await page.getByRole("combobox", { name: "Map metric", exact: true }).selectOption("successRate");
    await expect(page.locator(".recharts-errorBar")).not.toHaveCount(0);
    const points = page.getByRole("list", { name: "Map points" }).getByRole("button");
    await expect(points).toHaveCount(3);
    await points.nth(2).click();
    await expect(page.getByTestId("canvas-result-context")).toHaveAttribute("title", /Timeout · gateway → middle = 20 ms/);
    await expect(page.getByLabel("Grid point", { exact: true })).toHaveValue("p2");
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    expect(await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }))).toEqual({ x: false, y: false });
    await page.screenshot({ path: testInfo.outputPath("parameter-line.png") });
  } finally {
    await cleanupWorkspace(page, directory);
  }
});
