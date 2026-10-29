import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunSummary } from "../src/api/apiTypes";
import { formatDuration, formatNumber } from "../src/i18n/format";

test("shows the retry-storm saturation conclusion from the real summary for each variant", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/saturation-insight");
  await mkdir(directory);
  try {
    for (const name of ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"]) {
      await copyFile(resolve("../examples/retry-storm", name), resolve(directory, name));
    }
    await page.goto("/");
    await page.getByLabel("Experiment").selectOption("saturation-insight/retry-storm.experiment.json");
    const response = page.waitForResponse((response) => /\/api\/v1\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    for (const variant of summary.variants) {
      await page.getByRole("tab", { name: variant.label, exact: true }).click();
      for (const point of variant.points) {
        const first = point.saturation.firstNodes[0];
        expect(first).toBeDefined();
        if (summary.grid.length > 0) await page.getByLabel("Grid point", { exact: true }).selectOption(point.id);
        const insight = page.getByRole("region", { name: "Saturation insight" });
        await expect(insight.getByRole("heading")).toHaveText(`${variant.label} · ${point.id}`);
        await insight.scrollIntoViewIfNeeded();
        await expect(insight).toBeInViewport();
        await expect(insight).toContainText(`${first.node} first in ${formatNumber(first.replicationCount)} of ${formatNumber(variant.replications)} replications`);
        await expect(insight).toContainText(`median start ${formatDuration(first.medianStartMs)}`);
        await expect(insight).toContainText(`range ${formatNumber(first.minStartMs, 1)}–${formatDuration(first.maxStartMs)}`);
        await expect(insight).toContainText(`${formatNumber(point.saturation.withoutSaturation)} of ${formatNumber(variant.replications)} replications without saturation.`);
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
