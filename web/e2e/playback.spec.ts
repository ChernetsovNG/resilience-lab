import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { formatDuration, formatMultiplier, formatNumber } from "../src/i18n/format";
import type { components } from "../src/api/schema";

type Window = components["schemas"]["WindowMetrics"];

async function windows(request: APIRequestContext, runId: string) {
  const route = `/api/v1/runs/${runId}/series/baseline/p0/0`;
  const index: components["schemas"]["SeriesIndex"] = await (await request.get(route)).json();
  const nodes = new Map<string, Window[]>();
  for (const reference of index.parts) {
    const number = reference.file.replace(/^part-(\d+)\.json\.gz$/, "$1");
    const part: components["schemas"]["SeriesPart"] = await (await request.get(`${route}/${number}`)).json();
    for (const node of part.nodes) nodes.set(node.id, [...(nodes.get(node.id) ?? []), ...node.windows]);
  }
  for (const rows of nodes.values()) rows.sort((a, b) => a.startMs - b.startMs);
  return nodes;
}

async function seek(slider: Locator, index: number) {
  await slider.focus();
  await slider.press("Home");
  for (let step = 0; step < index; step++) await slider.press("ArrowRight");
}

test("retry-storm playback has deterministic window frames and a shared Timeline cursor without document writes", async ({ page, request }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/playback");
  const names = ["retry-storm.experiment.json", "retry-storm.model.json", "retry-storm.layout.json"];
  await mkdir(directory);
  try {
    for (const name of names) await copyFile(resolve("../examples/retry-storm", name), resolve(directory, name));
    const documents = () => Promise.all(names.map(async (name) =>
      (await request.get(`/api/v1/workspace/document?path=${encodeURIComponent(`playback/${name}`)}`)).json()));
    const beforeDocuments = await documents();
    await page.goto("/");
    await page.getByLabel("Experiment", { exact: true }).selectOption("playback/retry-storm.experiment.json");
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    const response = page.waitForResponse((response) => /\/runs\/[^/]+\/summary$/.test(response.url()));
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const runId = /\/runs\/([^/]+)\/summary$/.exec((await response).url())![1];
    const nodes = await windows(request, runId);
    const dependency = nodes.get("dependency")!;
    const client = nodes.get("client")!;
    const queue = (index: number) => dependency[index].queueLengthIntegralMs / dependency[index].durationMs;
    const amplification = (index: number) => dependency[index].admittedAttempts / client[index].originalArrivals;
    const candidates = dependency.map((_, index) => index).filter((index) =>
      dependency[index].startMs < 200 && client[index].originalArrivals > 0 && dependency[index].admittedAttempts > 0);
    const before = candidates.sort((a, b) => queue(a) - queue(b) || amplification(a) - amplification(b))[0];
    expect(before).toBeDefined();
    const during = dependency.map((_, index) => index).filter((index) =>
      dependency[index].startMs >= 200 && dependency[index].startMs < 700 &&
      client[index].originalArrivals > 0 && queue(index) > queue(before) && amplification(index) > amplification(before))
      .sort((a, b) => queue(b) - queue(a))[0];
    expect(during).toBeDefined();

    const slider = page.getByRole("slider", { name: "Playback window", exact: true });
    const context = page.getByTestId("canvas-result-context");
    const metrics = page.getByTestId("canvas-results-dependency");
    const edge = page.getByTestId("canvas-edge-label-middle-to-dependency").locator(".canvas-edge-results");
    await expect(context).toHaveAttribute("title", /Summary · Baseline/);
    await page.getByRole("button", { name: "Time", exact: true }).click();
    await seek(slider, before);
    await expect(context).toHaveAttribute("title", new RegExp(`Window ${formatNumber(before)} ·`));
    const status = page.getByRole("region", { name: "Status bar" });
    await expect(status).toContainText(`Cursor ${formatDuration(dependency[before].startMs)}`);
    await page.getByRole("button", { name: /fit view/i }).click();
    await expect(metrics).toContainText(`Mean queue ${formatNumber(queue(before))}`);
    await expect(edge).toHaveText(`Amplification ${formatMultiplier(amplification(before))}`);
    await seek(slider, during);
    await expect(metrics).toContainText(`Mean queue ${formatNumber(queue(during))}`);
    await expect(edge).toHaveText(`Amplification ${formatMultiplier(amplification(during))}`);
    await expect(edge).toHaveAttribute("title", /Window approximation/);
    const frame = { metrics: await metrics.locator("span").allTextContents(), edge: await edge.innerText() };
    await page.getByRole("button", { name: "Previous window", exact: true }).click();
    await expect(slider).toHaveValue(String(during - 1));
    await page.getByRole("button", { name: "Next window", exact: true }).click();
    await expect(metrics.locator("span")).toHaveText(frame.metrics);
    await expect(edge).toHaveText(frame.edge);
    await seek(slider, 0);
    await seek(slider, during);
    await expect(metrics.locator("span")).toHaveText(frame.metrics);
    await expect(edge).toHaveText(frame.edge);

    await page.getByTestId("rf__node-dependency").locator(".block-node > strong").click();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    const timelineCursor = page.getByTestId("timeline-cursor");
    await expect(timelineCursor).toContainText(`Window ${formatNumber(during)} ·`);
    const timelineSlider = page.getByRole("region", { name: "Queue", exact: true }).getByRole("slider");
    await timelineSlider.focus();
    await timelineSlider.press("End");
    await expect(slider).toHaveValue(String(dependency.length - 1));
    await expect(context).toHaveAttribute("title", new RegExp(`Window ${formatNumber(dependency.length - 1)} ·`));
    await expect(status).toContainText(`Cursor ${formatDuration(dependency.at(-1)!.startMs)}`);

    await seek(slider, 0);
    await page.getByLabel("Playback speed", { exact: true }).selectOption("0.25");
    await page.getByRole("button", { name: "Play run", exact: true }).click();
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause run", exact: true }).click();
    const paused = await slider.inputValue();
    await expect(context).toHaveAttribute("title", new RegExp(`Window ${formatNumber(Number(paused))} ·`));
    await expect(timelineCursor).toContainText(`Window ${formatNumber(Number(paused))} ·`);
    await page.waitForTimeout(160);
    await expect(slider).toHaveValue(paused);
    await seek(slider, during);
    await expect(metrics.locator("span")).toHaveText(frame.metrics);
    await expect(edge).toHaveText(frame.edge);
    await page.screenshot({ path: testInfo.outputPath("playback.png") });

    await page.getByLabel("Replication", { exact: true }).selectOption("1");
    await expect(context).toHaveAttribute("title", /replication 1/);
    await expect(page.getByLabel("Replication", { exact: true })).toHaveValue("1");
    await expect(page.locator(".timeline-toolbar").getByLabel("Replication", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear time cursor", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Summary", exact: true }).click();
    await expect(context).toHaveAttribute("title", /Summary · Baseline/);
    await expect(timelineCursor).toContainText("Hover to inspect windows");
    await expect(status).not.toContainText("Cursor");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    expect(await documents()).toEqual(beforeDocuments);
    expect(await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }))).toEqual({ x: false, y: false });
  } finally {
    await rm(directory, { recursive: true });
  }
});
