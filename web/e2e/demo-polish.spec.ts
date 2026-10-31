import { selectExperiment } from "./fixtures";
import { expect, test, type Page } from "./fixtures";
import type { components } from "../src/api/schema";

type Window = components["schemas"]["WindowMetrics"];

async function run(page: Page) {
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const response = page.waitForResponse((response) => /\/runs\/[^/]+\/summary$/.test(response.url()));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const runId = /\/runs\/([^/]+)\/summary$/.exec((await response).url())![1];
  await expect(page.getByRole("table", { name: "Answer", exact: true })).toBeVisible();
  return runId;
}

async function expectFitted(page: Page) {
  await expect.poll(() => page.locator(".canvas").evaluate((canvas) => {
    const flow = canvas.querySelector(".react-flow")!.getBoundingClientRect();
    const controls = [...canvas.querySelectorAll(".react-flow__controls, .react-flow__minimap")]
      .map((element) => element.getBoundingClientRect());
    const elements = [...canvas.querySelectorAll(".react-flow__node, .canvas-edge-label")];
    return elements.length > 0 && elements.every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= flow.left && rect.right <= flow.right &&
        rect.top >= flow.top && rect.bottom <= flow.bottom && controls.every((control) =>
          rect.right <= control.left || rect.left >= control.right || rect.bottom <= control.top || rect.top >= control.bottom);
    });
  })).toBe(true);
}

test("canvas fits without navigation overlap after panel changes and viewport resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await run(page);
  await expectFitted(page);
  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await expectFitted(page);
  await page.getByRole("button", { name: "Restore results", exact: true }).click();
  await expectFitted(page);
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await expectFitted(page);
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await expectFitted(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectFitted(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectFitted(page);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => ({
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }))).toEqual({ x: false, y: false });
});

test("latency markers show recorded windows and leave empty-window readouts unavailable", async ({ page, request }) => {
  const runId = await run(page);
  const route = `/api/v1/runs/${runId}/series/baseline/p0/0`;
  const index: components["schemas"]["SeriesIndex"] = await (await request.get(route)).json();
  const windows: Window[] = [];
  for (const reference of index.parts.filter((part) => part.nodes.includes("dependency"))) {
    const partNumber = reference.file.replace(/^part-(\d+)\.json\.gz$/, "$1");
    const part: components["schemas"]["SeriesPart"] = await (await request.get(`${route}/${partNumber}`)).json();
    windows.push(...part.nodes.find((node) => node.id === "dependency")!.windows);
  }
  windows.sort((left, right) => left.startMs - right.startMs);
  const empty = windows.findIndex((window) => window.startMs >= 200 && window.startMs < 700 && window.latency.count === 0);
  const observed = windows.filter((window) => window.startMs >= 200 && window.startMs < 700 && window.latency.count > 0);
  expect(empty).toBeGreaterThanOrEqual(0);
  expect(observed.length).toBeGreaterThan(0);
  await page.getByTestId("rf__node-dependency").locator(".block-node > strong").click();
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await page.getByText("Elements and metrics", { exact: true }).click();
  const metrics = page.getByRole("group", { name: "dependency · Service", exact: true });
  for (const name of ["p50 latency", "p95 latency", "p99 latency"]) {
    await metrics.getByRole("checkbox", { name, exact: true }).check();
  }
  await page.getByText("Elements and metrics", { exact: true }).click();
  const latency = page.getByRole("region", { name: "Latency", exact: true });
  await expect(latency.locator(".recharts-line-dots").first()).toBeVisible();
  const dots = latency.locator(".recharts-line-dots").first().locator("circle");
  await expect(dots).toHaveCount(windows.filter((window) => window.latency.count > 0).length);
  await expect(latency).toContainText("Empty windows have no latency value");
  const cursor = latency.getByRole("slider");
  await cursor.focus();
  await cursor.press("Home");
  for (let step = 0; step < empty; step++) await cursor.press("ArrowRight");
  await expect(latency.locator("dd")).toHaveText(["—", "—", "—", "—"]);
});
