import { selectExperiment } from "./fixtures";
import { expect, test } from "@playwright/test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, RunSummary } from "../src/api/apiTypes";
import { formatDuration, formatNumber } from "../src/i18n/format";

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
        const rule = insight.getByText("A service counts as saturated", { exact: false });
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
          await expect(insight.getByText(/^Capacity headroom:/)).toBeVisible();
          await expect(insight).toContainText("largest mean queue (pooled)");
          await expect(insight).toContainText(`entry p99 (pooled) ${formatDuration(point.aggregate.pooledLatency.all?.p99Ms)}`);
        } else {
          expect(first).toBeDefined();
          await expect(insight).toContainText(`${first.node} first in ${formatNumber(first.replicationCount)} of ${formatNumber(variant.replications)} replications`);
          await expect(insight).toContainText(`median start ${formatDuration(first.medianStartMs)}`);
          await expect(insight).toContainText(`range ${formatNumber(first.minStartMs, 1)}–${formatDuration(first.maxStartMs)}`);
          await expect(insight.getByText(/^Capacity headroom:/)).toHaveCount(0);
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
