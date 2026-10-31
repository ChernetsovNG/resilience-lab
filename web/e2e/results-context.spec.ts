import { expect, test } from "@playwright/test";
import { selectExperiment, copySmallExperiment } from "./fixtures";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

test.use({ viewport: { width: 1440, height: 900 } });

test("one context row gives the diagram more height and shares time with Timeline", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/results-context");
  await mkdir(directory);
  try {
    await copySmallExperiment(directory, "retry-storm.experiment.json", "3ms");
    const clockStart = Date.now();
    await page.clock.install({ time: clockStart });
    await page.goto("/");
    await selectExperiment(page, "results-context/retry-storm.experiment.json");
    const row = page.getByRole("region", { name: "Results context", exact: true });
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await expect(row).toHaveCount(0);
    const run = page.getByRole("button", { name: "Run", exact: true });
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "Summary", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row.getByLabel("Replication", { exact: true })).toBeEnabled();
    await expect(page.getByRole("region", { name: "Estimate", exact: true })).toHaveCount(0);
    const canvas = page.getByRole("application", { name: "Model canvas", exact: true });
    const box = (await canvas.boundingBox())!;
    // The main baseline for this issue at 1440×900 was 323.06 px after Run.
    expect(box.height).toBeGreaterThan(400);
    await testInfo.attach("canvas-height", { body: JSON.stringify(box), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("after-summary.png") });
    await page.getByRole("button", { name: "Estimate", exact: true }).click();
    await expect(page.getByRole("region", { name: "Cost estimate", exact: true })).toBeVisible();
    expect((await canvas.boundingBox())!.height).toBe(box.height);
    await page.screenshot({ path: testInfo.outputPath("estimate-popover.png") });
    await page.getByRole("button", { name: "Close estimate", exact: true }).click();
    await row.getByRole("button", { name: "Time", exact: true }).click();
    const window = row.getByRole("slider", { name: "Playback window", exact: true });
    await expect(window).toHaveValue("0");
    // Keep the Pause button from becoming Play before a delayed click is dispatched.
    await page.clock.pauseAt(clockStart + 3_600_000);
    await expect(page.getByTestId("canvas-results-dependency")).not.toHaveAttribute("aria-busy", "true");
    await row.getByLabel("Playback speed", { exact: true }).selectOption("4");
    await row.getByRole("button", { name: "Play run", exact: true }).click();
    await page.clock.runFor(320);
    await expect.poll(async () => Number(await window.inputValue())).toBeGreaterThan(0);
    await row.getByRole("button", { name: "Pause run", exact: true }).click();
    await expect(row.getByRole("button", { name: "Play run", exact: true })).toBeVisible();
    const firstPausedWindow = await window.inputValue();
    await page.clock.runFor(1000);
    await expect(window).toHaveValue(firstPausedWindow);
    await page.clock.resume();
    await window.focus();
    await window.press("Home");
    await window.press("ArrowRight");
    await expect(window).toHaveValue("1");
    await page.getByTestId("rf__node-dependency").click();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window 1");
    await expect(page.getByText("Loading series…", { exact: true })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("normal-layout.png") });
    await row.getByRole("button", { name: "Analysis", exact: true }).click();
    await expect(page.locator(".palette")).toBeHidden();
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(page.locator(".inspector").getByRole("textbox")).toHaveCount(0);
    await expect(canvas).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("region", { name: "Latency", exact: true })).toBeInViewport({ ratio: 0.5 });
    await page.clock.pauseAt(clockStart + 7_200_000);
    await window.fill("19");
    await expect(page.getByTestId("canvas-results-dependency")).toBeVisible();
    await expect(page.getByTestId("canvas-results-dependency")).not.toHaveAttribute("aria-busy", "true");
    const beforePlayback = await page.getByTestId("canvas-results-dependency").textContent();
    await row.getByRole("button", { name: "Play run", exact: true }).click();
    await page.clock.runFor(360);
    await expect.poll(async () => Number(await window.inputValue())).toBeGreaterThanOrEqual(32);
    await row.getByRole("button", { name: "Pause run", exact: true }).click();
    await expect(row.getByRole("button", { name: "Play run", exact: true })).toBeVisible();
    const playedWindow = await window.inputValue();
    await page.clock.runFor(1000);
    await expect(window).toHaveValue(playedWindow);
    await page.clock.resume();
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window " + playedWindow + " ·");
    await expect(page.getByTestId("canvas-results-dependency")).not.toHaveText(beforePlayback!);
    await expect(page.getByTestId("canvas-results-dependency")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("analysis-layout.png") });
    const divider = page.getByRole("separator", { name: "Resize results panel" });
    for (const key of ["Home", "End"]) {
      await divider.focus();
      await divider.press(key);
      expect(await page.evaluate(() => ({
        x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      }))).toEqual({ x: false, y: false });
      await expect(canvas).toBeInViewport({ ratio: 1 });
    }
    await divider.press("Escape");
    await expect(row.getByRole("button", { name: "Analysis", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(window).toHaveValue(playedWindow);

    await expect(page.locator(".timeline-toolbar").getByLabel("Replication", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear time cursor", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Return to summary", exact: true })).toHaveCount(0);
    await row.getByLabel("Replication", { exact: true }).selectOption("1");
    await expect(page.getByTestId("timeline-cursor")).toContainText("replication 1");
    await row.getByLabel("Node overlay", { exact: true }).selectOption("meanQueue");
    await expect(row.getByLabel("Node color scale", { exact: true })).toContainText("Queue fill: 0%–100%");
    expect(await row.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
    await expect(page.getByTestId("canvas-results-dependency")).toBeVisible();
    await expect(page.getByText("Loading series…", { exact: true })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("after-time.png") });
    await row.getByRole("button", { name: "Summary", exact: true }).click();
    await expect(page.getByTestId("timeline-cursor")).toContainText("Hover to inspect windows");
    await expect(window).toHaveCount(0);
    await row.getByLabel("Replication", { exact: true }).selectOption("0");
    await expect(row.getByRole("button", { name: "Summary", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row.getByLabel("Replication", { exact: true })).toHaveValue("0");
    await row.getByLabel("Node overlay", { exact: true }).selectOption("off");
    await expect(page.locator(".block-results:visible")).toHaveCount(0);
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  } finally {
    await rm(directory, { recursive: true });
  }
});
