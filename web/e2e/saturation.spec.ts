import { copySmallExperiment, selectExperiment } from "./fixtures";
import { expect, test } from "./fixtures";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, LayoutFile, RunSummary } from "../src/api/apiTypes";
import { formatDuration, formatNumber } from "../src/i18n/format";
import en from "../src/i18n/en.json" with { type: "json" };
import ru from "../src/i18n/ru.json" with { type: "json" };
import { expectReadableFocus } from "./canvasAssertions";

test("shows the retry-storm saturation conclusion from the real summary for each variant", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/saturation-insight");
  await mkdir(directory);
  try {
    for (const name of ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"]) {
      await copyFile(resolve("../examples/retry-storm", name), resolve(directory, name));
    }
    const experimentPath = resolve(directory, "retry-storm.experiment.json");
    const experiment: ExperimentFile = JSON.parse(await readFile(experimentPath, "utf8"));
    experiment.variants.push({ id: "high-capacity", label: "More handlers", overrides: {
      "gateway.handlers": 32, "middle.handlers": 32, "dependency.handlers": 32,
    } });
    await writeFile(experimentPath, JSON.stringify(experiment));
    await page.goto("/");
    await selectExperiment(page, "saturation-insight/retry-storm.experiment.json");
    const response = page.waitForResponse((response) => /\/api\/v1\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    for (const variant of summary.variants) {
      await page.getByRole("tab", { name: variant.label, exact: true }).click();
      for (const point of variant.points) {
        const first = point.saturation.firstNodes[0];

        if (summary.grid.length > 0) await page.getByLabel("Grid point", { exact: true }).selectOption(point.id);
        const insight = page.getByRole("region", { name: "Saturation insight" });
        await expect(insight.getByRole("heading")).toHaveText(variant.label);
        await expect(insight).not.toContainText(/Saturation rule:|minimumDurationMs\s*=/);
        const rule = insight.getByText("A resource pool (handlers or connections) counts as saturated", { exact: false });
        await expect(rule).toBeHidden();
        await insight.getByText("How saturation is detected", { exact: true }).click();
        await expect(rule).toBeVisible();
        await expect(rule).toContainText("at or above 95%");
        await insight.getByText("How saturation is detected", { exact: true }).click();
        await insight.scrollIntoViewIfNeeded();
        await expect(insight).toBeInViewport();
        if (variant.id === "high-capacity") {
          expect(point.saturation.firstNodes).toEqual([]);
          expect(point.saturation.withoutSaturation).toBe(variant.replications);
          await expect(insight).toContainText("No saturation.");
          await expect(insight.getByText(/^Capacity headroom/)).toBeVisible();
          await expect(insight).toContainText("largest mean number of queued requests");
          await expect(insight).toContainText(`entry p99 ${formatDuration(point.aggregate.entries.total.pooledLatency.all?.p99Ms)}`);
        } else {
          expect(first).toBeDefined();
          await expect(insight).toContainText(`${first.label.message} first in ${formatNumber(first.replicationCount)} of ${formatNumber(variant.replications)} replications`);
          await expect(insight).toContainText(`median start ${formatDuration(first.medianStartMs)}`);
          await expect(insight).toContainText(`range ${formatDuration(first.minStartMs)}–${formatDuration(first.maxStartMs)}`);
          await expect(insight.getByText(/^Capacity headroom/)).toHaveCount(0);
        }
        await expect(insight).toContainText(`${formatNumber(point.saturation.withoutSaturation)} of ${formatNumber(variant.replications)} replications without saturation.`);
        await page.screenshot({ path: testInfo.outputPath(`answer-${variant.id}.png`) });
      }
    }
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    expect(overflow).toEqual({ horizontal: false, vertical: false });
    await page.screenshot({ path: testInfo.outputPath("saturation-summary.png") });
  } finally {
    await rm(directory, { recursive: true });
  }
});

for (const locale of ["en-US", "ru-RU"]) test.describe(`readable result navigation (${locale})`, () => {
  test.use({ locale });
  const messages = locale === "ru-RU" ? ru : en;
  const language = locale === "ru-RU" ? "ru" : "en";
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    test(`Model points to results and saturation focuses the node at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const directory = resolve(`../apps/server/build/e2e-workspace/saturation-focus-${language}-${viewport.width}`);
      await mkdir(directory);
      try {
        const experiment = await copySmallExperiment(directory);
        experiment.execution.measurement = "1s";
        experiment.faults = experiment.faults?.map(fault => ({ ...fault, from: "100ms", to: "800ms" }));
        await writeFile(resolve(directory, "retry-storm.experiment.json"), JSON.stringify(experiment));
        const layoutPath = resolve(directory, "retry-storm.layout.json");
        const layout: LayoutFile = JSON.parse(await readFile(layoutPath, "utf8"));
        for (const position of Object.values(layout.positions)) position.x *= 4;
        await writeFile(layoutPath, JSON.stringify(layout));
        await page.goto("/");
        await selectExperiment(page, `saturation-focus-${language}-${viewport.width}/retry-storm.experiment.json`);
        const hint = page.getByRole("button", { name: messages["app.canvas.openVariantResults"].replace("{variant}", "Baseline"), exact: true });
        await expect(hint).toHaveCount(0);
        const run = page.getByRole("button", { name: messages["app.topBar.run"], exact: true });
        await expect(run).toBeEnabled();
        const canvasChromeHeight = async () => (await page.locator(".canvas-area").boundingBox())!.height
          - (await page.locator(".react-flow").boundingBox())!.height;
        const fullCanvasHeight = async () => (await page.locator(".react-flow").boundingBox())!.height
          + (await page.getByRole("region", { name: messages["course.title"], exact: true }).boundingBox())!.height;
        const chromeBeforeResults = await canvasChromeHeight();
        const heightBeforeResults = await fullCanvasHeight();
        const response = page.waitForResponse(response => /\/api\/v1\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
        await run.click();
        const summary: RunSummary = await (await response).json();
        await expect(page.getByTestId("job-status")).toHaveText(messages["app.job.status.COMPLETED"]);
        await expect(hint).toBeVisible();
        await expect.poll(canvasChromeHeight).toBeCloseTo(chromeBeforeResults, 1);
        await expect(page.getByText(messages["app.canvas.modelResultsHint"], { exact: true })).toBeVisible();
        const overlay = page.locator(".model-results-hint");
        const overlappingElements = () => overlay.evaluate(element => {
          const hint = element.getBoundingClientRect();
          return [...document.querySelectorAll(".react-flow__node, .canvas-navigation")].filter(target => {
            const rect = target.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left < hint.right && rect.right > hint.left
              && rect.top < hint.bottom && rect.bottom > hint.top;
          }).map(target => target.getAttribute("data-id") ?? target.className);
        });
        await expect.poll(overlappingElements).toEqual([]);
        const about = (await page.getByRole("button", { name: messages["app.canvas.aboutModel"], exact: true }).boundingBox())!;
        const hintBox = (await overlay.boundingBox())!;
        expect(hintBox.x).toBeGreaterThan(about.x + about.width);
        expect(hintBox.y).toBeCloseTo(about.y, 0);
        await page.screenshot({ path: testInfo.outputPath(`model-results-hint-${language}-${viewport.width}.png`) });

        const longLabel = `Baseline: ${"long variant name ".repeat(20).trim()}`;
        experiment.variants[0].label = longLabel;
        await writeFile(resolve(directory, "retry-storm.experiment.json"), JSON.stringify(experiment));
        await page.reload();
        await selectExperiment(page, `saturation-focus-${language}-${viewport.width}/retry-storm.experiment.json`);
        const longHint = page.getByRole("button", { name: messages["app.canvas.openVariantResults"].replace("{variant}", longLabel), exact: true });
        await expect(longHint).toBeVisible();
        await expect(longHint).toHaveAttribute("title", messages["app.canvas.openVariantResults"].replace("{variant}", longLabel));
        expect(await longHint.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        const longBox = (await overlay.boundingBox())!;
        expect(longBox.height).toBeCloseTo(hintBox.height, 0);
        await expect.poll(overlappingElements).toEqual([]);
        await expect.poll(fullCanvasHeight).toBeCloseTo(heightBeforeResults, 1);
        await page.screenshot({ path: testInfo.outputPath(`model-results-hint-long-${language}-${viewport.width}.png`) });
        experiment.variants[0].label = "Baseline";
        await writeFile(resolve(directory, "retry-storm.experiment.json"), JSON.stringify(experiment));
        await page.reload();
        await selectExperiment(page, `saturation-focus-${language}-${viewport.width}/retry-storm.experiment.json`);
        await expect(hint).toBeVisible();
        await hint.click();
        await expect(page.locator("#variant-baseline")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("region", { name: messages["app.canvas.results"], exact: true })).toBeVisible();
        await expect(hint).toHaveCount(0);

        await page.getByRole("tab", { name: messages["editor.pages.model"], exact: true }).click();
        await page.getByRole("button", { name: messages["results.restore"], exact: true }).click();
        const first = summary.variants[0].points[0].saturation.firstNodes[0];
        expect(first).toBeDefined();
        const insight = page.getByRole("region", { name: messages["results.saturation.title"], exact: true });
        await insight.locator(".saturation-insight > p button.result-element-link").first().click();
        const node = page.getByTestId(`rf__node-${first.node}`);
        const zoom = () => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
        await expect(node).toHaveClass(/selected/);
        await expect.poll(zoom).toBeGreaterThanOrEqual(0.7);
        await expectReadableFocus(node);
        await page.screenshot({ path: testInfo.outputPath(`saturation-focus-${language}-${viewport.width}.png`) });

        await page.getByRole("tab", { name: messages["editor.pages.model"], exact: true }).click();
        await insight.getByText(messages["results.saturation.degradationPaths"], { exact: true }).click();
        await insight.locator("li button.result-element-link").first().click();
        await expect(page.locator("#variant-baseline")).toHaveAttribute("aria-selected", "true");
        await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
        await expect.poll(zoom).toBeGreaterThanOrEqual(0.7);
        await expect(page.getByRole("button", { name: messages["app.topBar.save"], exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: messages["app.topBar.undo"], exact: true })).toBeDisabled();
      } finally {
        await rm(directory, { recursive: true });
      }
    });
  }
});
