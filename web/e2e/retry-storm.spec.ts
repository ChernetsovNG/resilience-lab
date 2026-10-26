import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ExperimentResult } from "../src/api/types";

async function useShortExecution(page: Page) {
  await page.getByLabel("Replications", { exact: true }).fill("2");
  await page.getByLabel("Warm-up (ms)", { exact: true }).fill("0");
  await page.getByLabel("Measurement (ms)", { exact: true }).fill("50");
  await page.getByLabel("Maximum real time (seconds)", { exact: true }).fill("1");
}

async function expectNumericMetric(scope: Locator, label: string) {
  const card = scope.locator(".metric-card").filter({ hasText: label });
  await expect(card).toHaveCount(1);
  await expect(card.locator("dd")).not.toHaveText("N/A");
  await expect(card.locator("dd")).toContainText(/[0-9]/);
}

test("creates, reconnects and runs a degraded comparison through the real UI", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();

  await page.getByRole("button", { name: "New three-service chain" }).click();
  await expect(page.getByTestId("service-block")).toHaveCount(3);
  await page.getByRole("button", { name: "Add service" }).click();
  await expect(page.getByTestId("service-block")).toHaveCount(4);

  await page.locator('.react-flow__node[data-id="service-3"]').click();
  await page.getByRole("button", { name: "Delete selected service" }).click();
  await expect(page.getByTestId("service-block")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  const source = await page
    .locator('.react-flow__node[data-id="service-2"] .react-flow__handle.source')
    .boundingBox();
  const target = await page
    .locator('.react-flow__node[data-id="service-4"] .react-flow__handle.target')
    .boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  await page.getByLabel("Enable degradation").check();
  await page.getByLabel("Processing multiplier", { exact: true }).fill("2");
  await useShortExecution(page);
  await page.getByRole("button", { name: "Run comparison", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });

  for (const variant of ["Baseline", "Candidate"]) {
    const metrics = page.getByRole("region", { name: `${variant} metrics` });
    await expect(metrics).toBeVisible();
    await expectNumericMetric(metrics, "Success rate");
    await expectNumericMetric(metrics, "Pooled all-latency p95");
    await expectNumericMetric(metrics, "Pooled all-latency p99");
    await expectNumericMetric(metrics, "service-1 admitted amplification");
  }

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("result-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("experiment-result.json");
  const result = JSON.parse(await readFile((await download.path())!, "utf8")) as ExperimentResult;
  expect(result.schemaVersion).toBe(1);
  expect(result.variants.map((variant) => variant.id)).toEqual(["baseline", "candidate"]);
  for (const variant of result.variants) {
    expect(variant.replications).toHaveLength(2);
    expect(variant.aggregate.successRate?.mean).toEqual(expect.any(Number));
    expect(variant.aggregate.p95LatencyMs?.mean).toEqual(expect.any(Number));
    expect(variant.aggregate.p99LatencyMs?.mean).toEqual(expect.any(Number));
    expect(variant.aggregate.services["service-1"].admittedAmplification?.mean).toEqual(
      expect.any(Number),
    );
  }
});
