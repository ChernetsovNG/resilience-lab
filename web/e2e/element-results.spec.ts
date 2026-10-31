import { selectExperiment } from "./fixtures";
import { expect, test } from "./fixtures";
import type { RunSummary } from "../src/api/apiTypes";
import { formatNumber, formatPercent, formatRate } from "../src/i18n/format";

test("service and call inspectors share Summary, Time and Timeline, including Analysis", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await selectExperiment(page, "retry-storm/retry-storm.experiment.json");
  await page.getByTestId("rf__node-gateway").click();
  await expect(page.locator(".element-results")).toHaveCount(0);
  await page.getByRole("tab", { name: "Baseline", exact: true }).click();
  const response = page.waitForResponse(response => /\/runs\/[^/]+\/summary$/.test(response.url()));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const summary: RunSummary = await (await response).json();
  await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
  await page.getByTestId("rf__node-gateway").click();
  const results = page.locator(".element-results");
  await expect(results).toContainText("Pooled");
  await expect(results).toContainText("Handler utilization");
  await expect(results.locator("svg")).toHaveCount(2);
  await expect(page.getByLabel("Handlers", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Collapse results", exact: true }).click();
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("service-inspector.png") });

  const badge = page.getByTestId("canvas-edge-label-gateway-to-middle");
  await badge.click();
  await expect(page.locator(".inspector h2").first()).toHaveText("gateway-to-middle");
  await expect(results).toContainText("Mean call duration");
  await expect(results).toContainText("Mean orphaned work");
  const connection = summary.variants.find(variant => variant.id === "baseline")!.points[0].aggregate.connections["gateway-to-middle"];
  const orphaned = results.getByRole("row", { name: /^Orphaned attempts/ });
  const replications = summary.variants.find(variant => variant.id === "baseline")!.replications;
  await expect(orphaned).toContainText(formatNumber(connection.totals.orphaned / replications));
  await expect(orphaned).toContainText("per replication");
  const overlay = page.getByLabel("Connection overlay", { exact: true });
  await overlay.selectOption("sentAttemptsPerSecond");
  await expect(badge).toContainText(formatRate(connection.totals.sentAttempts * 1000 / connection.totals.measurementMs));
  await overlay.selectOption("timeoutRate");
  await expect(badge).toContainText(formatPercent(connection.timeoutRate?.mean ?? null));
  await overlay.selectOption("amplification");
  const overlaps = await page.locator(".canvas-edge-label").evaluateAll(labels => {
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    return labels.filter(label => {
      const a = label.getBoundingClientRect();
      return nodes.some(node => {
        const b = node.getBoundingClientRect();
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      });
    }).map(label => label.getAttribute("data-testid"));
  });
  expect(overlaps).toEqual([]);
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("connection-inspector.png") });

  await results.getByRole("button", { name: "Show on Timeline", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Timeline", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Rates", exact: true })).toContainText("gateway-to-middle · Sent attempts");
  await expect(page.getByRole("region", { name: "Latency", exact: true })).toContainText("gateway-to-middle");
  await page.getByRole("button", { name: "Time", exact: true }).click();
  await expect(results).toContainText("Window 0");
  await expect(results.locator('[data-testid="mini-cursor"]')).toHaveCount(3);
  const latency = page.getByRole("region", { name: "Latency", exact: true });
  await latency.getByRole("slider").focus();
  await latency.getByRole("slider").press("ArrowRight");
  await expect(results).toContainText("Window 1");
  await page.screenshot({ path: testInfo.outputPath("connection-timeline.png") });

  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await expect(results).toBeVisible();
  await expect(page.getByLabel("Timeout", { exact: true })).toBeHidden();
  await expect(page.locator(".palette")).toBeHidden();
  await expect(page.getByRole("separator", { name: "Resize inspector", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /fit view/i }).click();
  await page.screenshot({ path: testInfo.outputPath("analysis-results.png") });

  // The invisible path is clickable outside the visible stroke and away from the badge.
  const path = page.getByTestId("rf__edge-middle-to-dependency").locator(".react-flow__edge-interaction");
  await path.scrollIntoViewIfNeeded();
  const point = await path.evaluate(element => {
    const line = element as SVGPathElement;
    const point = line.getPointAtLength(line.getTotalLength() * 0.7);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(line.getScreenCTM()!);
    return { x: screen.x, y: screen.y + 7 };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".inspector h2").first()).toHaveText("middle-to-dependency");
  await page.getByTestId("rf__node-gateway").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByRole("region", { name: "Rates", exact: true })).toContainText("middle-to-dependency · Sent attempts");
  await expect(page.getByRole("region", { name: "Rates", exact: true })).toContainText("gateway ·");
  await page.getByRole("button", { name: "Analysis", exact: true }).click();
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await expect(page.locator(".element-results")).toHaveCount(0);
});
