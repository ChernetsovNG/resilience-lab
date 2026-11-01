import { selectExperiment } from "./fixtures";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./fixtures";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile } from "../src/api/apiTypes";
import type { components } from "../src/api/schema";

type Window = components["schemas"]["WindowMetrics"];

async function run(page: Page) {
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const response = page.waitForResponse((response) => /\/runs\/[^/]+\/summary$/.test(response.url()));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const summary = await response;
  await expect(page.getByRole("table", { name: "Findings" })).toBeVisible();
  return /\/runs\/([^/]+)\/summary$/.exec(summary.url())![1];
}

async function windows(request: APIRequestContext, runId: string, variant: string, replication: number) {
  const route = `/api/v1/runs/${runId}/series/${variant}/p0/${replication}`;
  const index: components["schemas"]["SeriesIndex"] = await (await request.get(route)).json();
  const result: Window[] = [];
  for (const reference of index.parts.filter((part) => part.nodes.includes("dependency"))) {
    const part = reference.file.replace(/^part-(\d+)\.json\.gz$/, "$1");
    const body: components["schemas"]["SeriesPart"] = await (await request.get(`${route}/${part}`)).json();
    result.push(...body.nodes.find((node) => node.id === "dependency")!.windows);
  }
  return result.sort((left, right) => left.startMs - right.startMs);
}

async function inspect(page: Page, slider: Locator, window: Window, endMs: number, pin = false) {
  await slider.scrollIntoViewIfNeeded();
  const bounds = (await slider.boundingBox())!;
  const x = bounds.x + (window.startMs + window.durationMs / 2) / endMs * bounds.width;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  if (pin) await page.mouse.click(x, y);
}

async function value(chart: Locator, metric: string, variant = "baseline") {
  const row = chart.locator(".timeline-readout > div").filter({ has: chart.page().getByText(`dependency · ${metric} ·`, { exact: false }) })
    .filter({ hasText: variant === "baseline" ? " · Baseline" : " · No retries" });
  return Number((await row.locator("dd").innerText()).replace(/,/g, "").split(" ")[0]);
}

test("retry-storm Timeline shows queue/errors growth, overlay and a shared pinned cursor", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await expect(page.getByTestId("rf__node-dependency")).toBeVisible();
  await page.getByTestId("rf__node-dependency").click();
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  const runId = await run(page);
  const baseline = await windows(request, runId, "baseline", 0);
  const noRetries = await windows(request, runId, "no-retries", 0);
  const endMs = baseline.at(-1)!.startMs + baseline.at(-1)!.durationMs;
  const before = baseline.filter((window) => window.startMs < 200).sort((a, b) => a.slotPools.handlers.queueIntegralMs - b.slotPools.handlers.queueIntegralMs)[0];
  const during = baseline.filter((window) => window.startMs >= 200 && window.startMs < 700);
  const queuePeak = during.toSorted((a, b) => b.slotPools.handlers.queueIntegralMs / b.durationMs - a.slotPools.handlers.queueIntegralMs / a.durationMs)[0];
  const errorPeak = during.toSorted((a, b) => b.slotPools.handlers.queueFullCount / b.durationMs - a.slotPools.handlers.queueFullCount / a.durationMs)[0];
  expect(queuePeak.slotPools.handlers.queueIntegralMs / queuePeak.durationMs).toBeGreaterThan(before.slotPools.handlers.queueIntegralMs / before.durationMs);
  expect(errorPeak.slotPools.handlers.queueFullCount).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(page.getByText("Loading series…", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Replication", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Time regions")).toContainText("Fault: dependency: 200 ms–700 ms");
  await page.getByText("Elements and metrics", { exact: true }).click();
  await page.getByRole("group", { name: "dependency · Service", exact: true }).getByRole("checkbox", { name: "Queue rejections", exact: true }).check();
  await page.getByText("Elements and metrics", { exact: true }).click();
  const queue = page.getByRole("region", { name: "Queue", exact: true });
  const errors = page.getByRole("region", { name: "Errors and rejections", exact: true });
  const queueSlider = queue.getByRole("slider");
  await inspect(page, queueSlider, before, endMs);
  const queueBefore = await value(queue, "Mean queue");
  await inspect(page, queueSlider, queuePeak, endMs);
  expect(await value(queue, "Mean queue")).toBeCloseTo(queuePeak.slotPools.handlers.queueIntegralMs / queuePeak.durationMs, 2);
  expect(await value(queue, "Mean queue")).toBeGreaterThan(queueBefore);
  await inspect(page, queueSlider, errorPeak, endMs);
  expect(await value(errors, "Queue rejections")).toBeCloseTo(errorPeak.slotPools.handlers.queueFullCount * 1000 / errorPeak.durationMs, 2);

  await page.getByLabel("Compare variant").selectOption("no-retries");
  await expect(queue.locator('path.recharts-line-curve[stroke-dasharray="6 4"]')).toBeVisible();
  await inspect(page, queueSlider, queuePeak, endMs, true);
  const pinned = baseline.indexOf(queuePeak);
  await expect(page.getByTestId("timeline-cursor")).toContainText(`Window ${pinned} ·`);
  await expect(page.getByTestId("timeline-cursor")).toContainText("pinned");
  expect(await value(queue, "Mean queue", "no-retries")).toBeCloseTo(noRetries[pinned].slotPools.handlers.queueIntegralMs / noRetries[pinned].durationMs, 2);

  await page.getByLabel("Replication", { exact: true }).selectOption("1");
  await expect(page.getByText("Loading series…", { exact: true })).toBeHidden();
  await expect(page.getByTestId("timeline-cursor")).toContainText("replication 1 · pinned");
  await page.getByText("Elements and metrics", { exact: true }).click();
  await page.getByRole("checkbox", { name: "gateway", exact: true }).check();
  await page.getByRole("checkbox", { name: "dependency", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "p99 latency", exact: true }).uncheck();
  await page.getByText("Elements and metrics", { exact: true }).click();
  await page.getByRole("tab", { name: "Findings", exact: true }).click();
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(page.getByLabel("Replication", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Compare variant", { exact: true })).toHaveValue("no-retries");
  await page.getByText("Elements and metrics", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "gateway", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "dependency", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "p99 latency", exact: true })).not.toBeChecked();
  await page.getByText("Elements and metrics", { exact: true }).click();
  await expect(page.getByTestId("timeline-cursor")).toContainText(`Window ${pinned} ·`);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();

  await page.getByTestId("rf__node-gateway").click();
  await expect(queue.locator("dt").first()).toContainText("gateway · Mean queue");
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("timeline.png") });
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(page.getByTestId("timeline-cursor")).toContainText("Hover to inspect");
  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await page.getByRole("button", { name: "Expand results", exact: true }).click();
  await expect(page.getByLabel("Compare variant", { exact: true })).toHaveValue("no-retries");
});

test("grid point and replication persist across views; warmup and the last short window use run metadata", async ({ page }, testInfo) => {
  const folder = resolve("../apps/server/build/e2e-workspace", `timeline-${testInfo.testId.replace(/\W/g, "")}`);
  const document: ExperimentFile = JSON.parse(await readFile(resolve("../examples/retry-storm/retry-storm.experiment.json"), "utf8"));
  document.modelRef = "../retry-storm/retry-storm.model.json";
  document.layoutRef = "../retry-storm/retry-storm.layout.json";
  document.execution.warmup = "100ms";
  document.execution.window = "40ms";
  document.grid = [{ path: "dependency.handlers", values: [2, 3] }];
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, "timeline.experiment.json"), JSON.stringify(document));
  try {
    await page.goto("/");
    await selectExperiment(page, `${folder.split("/").at(-1)}/timeline.experiment.json`);
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    const runId = await run(page);
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByLabel("Time regions")).toContainText("Warmup: 0 ms–100 ms");
    const pointRequest = page.waitForResponse((response) => response.url().includes(`/runs/${runId}/series/baseline/p1/0`));
    await page.getByLabel("Grid point", { exact: true }).selectOption("p1");
    await pointRequest;
    await expect(page.getByRole("region", { name: "Queue", exact: true })).toBeVisible();
    const slider = page.getByRole("region", { name: "Queue", exact: true }).getByRole("slider");
    await slider.focus();
    await slider.press("End");
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window 27 · 1.08 s–1.1 s");
    await page.getByRole("tab", { name: "Findings", exact: true }).click();
    await expect(page.getByLabel("Grid point", { exact: true })).toHaveValue("p1");
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window 27 · 1.08 s–1.1 s");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
