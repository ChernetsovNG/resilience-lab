import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunSummary } from "../src/api/apiTypes";

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
    const table = page.getByRole("table", { name: "Summary" });
    for (const variant of summary.variants) {
      for (const point of variant.points) {
        const first = point.saturation.firstNodes[0];
        expect(first).toBeDefined();
        const row = table.getByRole("row", { name: new RegExp(`${variant.label} ${point.id} `) });
        const insight = row.locator(".saturation-insight");
        await insight.scrollIntoViewIfNeeded();
        await expect(insight).toBeInViewport();
        await expect(insight).toContainText(`${first.node} first in ${first.replicationCount} of ${variant.replications} replications`);
        await expect(insight).toContainText(`median start ${first.medianStartMs.toFixed(1)} ms`);
        await expect(insight).toContainText(`range ${first.minStartMs.toFixed(1)}–${first.maxStartMs.toFixed(1)} ms`);
        await expect(insight).toContainText(`${point.saturation.withoutSaturation} of ${variant.replications} replications without saturation.`);
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
