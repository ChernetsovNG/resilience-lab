import { expect, test } from "@playwright/test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile, RunSummary } from "../src/api/apiTypes";

test("maps real summary metrics and the saturation badge to the variant diagram without document writes", async ({ page, request }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/canvas-results");
  const experimentPath = "canvas-results/retry-storm.experiment.json";
  const names = ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"];
  await mkdir(directory);
  try {
    for (const name of names) await copyFile(resolve("../examples/retry-storm", name), resolve(directory, name));
    const experimentFile = resolve(directory, names[0]);
    const document: ExperimentFile = JSON.parse(await readFile(experimentFile, "utf8"));
    document.grid = [{ path: "gateway.handlers", values: [4, 6] }];
    await writeFile(experimentFile, JSON.stringify(document));
    const documents = async () => Promise.all(names.map(async (name) =>
      (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`canvas-results/${name}`)}`)).json()));
    const before = await documents();

    await page.goto("/");
    await page.getByLabel("Experiment").selectOption(experimentPath);
    const response = page.waitForResponse((response) => /\/api\/v1\/runs\/[^/]+\/summary$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const summary: RunSummary = await (await response).json();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    const toolbar = page.getByRole("region", { name: "Canvas results" });
    await expect(toolbar).toHaveCount(0);
    await expect(page.locator(".block-results")).toHaveCount(0);
    const table = page.getByRole("table", { name: "Summary" });
    const headers = await table.locator("thead th").allTextContents();
    expect(summary.variants[0].points[0].saturation.firstNodes[0]).toBeDefined();

    for (const variant of summary.variants) {
      await page.getByRole("tab", { name: variant.label, exact: true }).click();
      for (const point of variant.points) {
        await page.getByLabel("Grid point").selectOption(point.id);
        await expect(toolbar).toContainText(`Summary · ${variant.label} · ${point.id} · measurement interval`);
        await expect(toolbar).toContainText("Utilization (pooled)");
        const row = table.getByRole("row", { name: new RegExp(`${variant.label} ${point.id} `) });
        for (const [id, service] of Object.entries(point.aggregate.services)) {
          const totals = service.totals;
          const utilization = `${(100 * totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs).toFixed(1)}%`;
          const metrics = page.getByTestId(`canvas-results-${id}`);
          await expect(metrics).toContainText(`Utilization ${utilization}`);
          await expect(metrics).toContainText(`Mean queue ${(totals.queueLengthIntegralMs / totals.measurementMs).toFixed(2)}`);
          await expect(metrics).toContainText(`Queue rejections ${(100 * totals.queueRejections / totals.offeredAttempts).toFixed(1)}%`);
          await expect(row.locator("th,td").nth(headers.indexOf(`${id} handler utilization (busy/capacity)`))).toHaveText(utilization);
          const amplification = `${service.admittedAmplification!.mean.toFixed(2)}×`;
          const connection = id === "gateway" ? "client-to-gateway" : id === "middle" ? "gateway-to-middle" : "middle-to-dependency";
          await expect(page.getByTestId(`canvas-edge-label-${connection}`)).toContainText(`Amplification ${amplification}`);
          await expect(row.locator("th,td").nth(headers.indexOf(`${id} admitted ×`))).toContainText(amplification);
          expect(await page.getByTestId(`rf__node-${id}`).locator(".block-node").evaluate((node) =>
            (node as HTMLElement).style.backgroundColor)).not.toBe("");
        }
        const first = point.saturation.firstNodes[0];
        const badge = page.getByRole("img", { name: "First saturated node", exact: true });
        await expect(badge).toHaveCount(first === undefined ? 0 : 1);
        if (first !== undefined) {
          await expect(page.getByTestId(`rf__node-${first.node}`).getByRole("img", { name: "First saturated node" })).toBeVisible();
          await expect(badge).toHaveAttribute("title", `${first.replicationCount} of ${variant.replications} replications`);
          await expect(row).toContainText(`${first.node} first in ${first.replicationCount} of ${variant.replications} replications`);
        }
      }
    }

    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await page.getByLabel("Grid point").selectOption("p0");
    await page.getByRole("button", { name: "Collapse results", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeHidden();
    await expect(page.getByRole("img", { name: "First saturated node" })).toBeVisible();
    const toggle = page.getByRole("checkbox", { name: "Show results on diagram" });
    await toggle.uncheck();
    await expect(page.locator(".block-results")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "First saturated node" })).toHaveCount(0);
    await toggle.check();
    await expect(page.locator(".block-results")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();

    const parameter = page.getByTestId("canvas-param-gateway-handlers");
    await parameter.dblclick();
    await parameter.locator("input").fill("7");
    await parameter.locator("input").press("Enter");
    await expect(toolbar).toContainText("Results belong to a previous document version.");
    await expect(page.getByTestId("canvas-results-gateway")).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toolbar).not.toContainText("Results belong to a previous document version.");
    await expect(parameter).toHaveText("4");
    expect(await documents()).toEqual(before);

    await page.getByRole("tab", { name: "Model", exact: true }).click();
    await expect(toolbar).toHaveCount(0);
    await expect(page.locator(".block-results")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "First saturated node" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    expect(overflow).toEqual({ horizontal: false, vertical: false });
    await page.screenshot({ path: testInfo.outputPath("canvas-results.png") });
  } finally {
    await rm(directory, { recursive: true });
  }
});
