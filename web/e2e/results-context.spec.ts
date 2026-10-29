import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

test.use({ viewport: { width: 1440, height: 900 } });

test("one context row gives the diagram more height and shares time with Timeline", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/results-context");
  await mkdir(directory);
  try {
    for (const name of ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"]) {
      await copyFile(resolve("../examples/retry-storm", name), resolve(directory, name));
    }
    await page.goto("/");
    await page.getByLabel("Experiment", { exact: true }).selectOption("results-context/retry-storm.experiment.json");
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
    await row.getByLabel("Playback speed", { exact: true }).selectOption("0.25");
    await row.getByRole("button", { name: "Play run", exact: true }).click();
    await expect.poll(async () => Number(await window.inputValue())).toBeGreaterThan(0);
    await row.getByRole("button", { name: "Pause run", exact: true }).click();
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
    await expect(page.locator(".inspector")).toBeHidden();
    await expect(canvas).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("region", { name: "Latency", exact: true })).toBeInViewport({ ratio: 0.5 });
    await window.focus();
    await window.press("Home");
    for (let index = 0; index < 19; index++) await window.press("ArrowRight");
    await expect(page.getByTestId("canvas-results-dependency")).toBeVisible();
    const beforePlayback = await page.getByTestId("canvas-results-dependency").textContent();
    await row.getByRole("button", { name: "Play run", exact: true }).click();
    await expect.poll(async () => Number(await window.inputValue())).toBeGreaterThanOrEqual(25);
    await row.getByRole("button", { name: "Pause run", exact: true }).click();
    const playedWindow = await window.inputValue();
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
    await expect(page.locator(".block-results")).toHaveCount(0);
    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  } finally {
    await rm(directory, { recursive: true });
  }
});
