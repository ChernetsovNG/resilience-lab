import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { ExperimentDocument, ExperimentResult, ExperimentSubmission } from "../src/api/types";

test("exports RPS in scenario units and restores RPS on import", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  const arrivalRate = page.getByLabel("Arrival rate (RPS)", { exact: true });
  await expect(arrivalRate).toHaveValue("100");

  for (const [rps, storedRate] of [[100, 0.1], [125.5, 0.1255], [63.75, 0.06375]]) {
    await arrivalRate.fill("");
    await arrivalRate.pressSequentially(String(rps));
    await expect(arrivalRate).toHaveValue(String(rps));
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export experiment", exact: true }).click();
    const download = await downloadPromise;
    const path = (await download.path())!;
    const experiment = JSON.parse(await readFile(path, "utf8")) as ExperimentDocument;
    expect(experiment.variants[0].scenario.workload.arrivalRate).toBe(storedRate);

    await arrivalRate.fill("250");
    await page.getByLabel("Import experiment", { exact: true }).setInputFiles(path);
    await expect(arrivalRate).toHaveValue(String(rps));

    await arrivalRate.fill("250");
    await page.getByLabel("Import scenario", { exact: true }).setInputFiles({
      name: "scenario.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(experiment.variants[0].scenario)),
    });
    await expect(arrivalRate).toHaveValue(String(rps));
  }
});

test("submits arrival-rate sweeps in scenario units and displays results in RPS", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await page.getByLabel("Sweep values (RPS)", { exact: true }).fill("25, 50.5");
  await page.getByRole("button", { name: "Apply sweep", exact: true }).click();
  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/v1/experiments"),
  );
  await page.getByRole("button", { name: "Run sweep", exact: true }).click();
  const submission = (await requestPromise).postDataJSON() as ExperimentSubmission;
  expect(submission.sweep?.sweep.values).toEqual([0.025, 0.0505]);
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });

  const chart = page.getByRole("figure", { name: "Parameter sweep" });
  const points = chart.locator("figcaption").getByRole("listitem");
  await expect(points).toHaveCount(2);
  await expect(points.nth(0)).toContainText("25 RPS:");
  await expect(points.nth(1)).toContainText("50.5 RPS:");
  await expect(chart.locator(".recharts-line-dots circle")).toHaveCount(2);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("result-download").click();
  const download = await downloadPromise;
  const result = JSON.parse(await readFile((await download.path())!, "utf8")) as ExperimentResult;
  expect(result.variants.map((variant) => variant.sweepValue)).toEqual([0.025, 0.0505]);
});

test("keeps the default retry-storm baseline below overload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Backend healthy/)).toBeVisible();
  await page.getByRole("button", { name: "Load retry storm example", exact: true }).click();
  await page.getByRole("button", { name: "Run comparison", exact: true }).click();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED", { timeout: 60_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("result-download").click();
  const download = await downloadPromise;
  const result = JSON.parse(await readFile((await download.path())!, "utf8")) as ExperimentResult & {
    submission: ExperimentSubmission;
  };
  const baseline = result.variants.find((variant) => variant.id === "baseline")!;
  console.log("Default baseline success rate:", baseline.aggregate.successRate?.mean);
  console.log("Default baseline arrivals:", baseline.replications.map((replication) => replication.originalArrivals));
  expect(baseline.replications).toHaveLength(3);
  expect(baseline.aggregate.successRate?.mean).toBeGreaterThan(0.95);
  expect(result.submission.experiment?.variants[0].scenario.workload.arrivalRate).toBe(0.1);
});
