import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summary } from "../test/fixtures";
import { GridMap } from "./GridMap";
import { gridCells, mapMetric } from "./map";
import { setConfidenceLevel } from "../layout/confidenceLevel";

afterEach(() => { act(() => setConfidenceLevel(95)); localStorage.clear(); });

it.each([false, true])("updates Map intervals and descriptions without changing the mean (two axes: %s)", twoAxes => {
  const run = gridSummary(twoAxes);
  run.variants[0].replications = 20;
  run.variants[0].points[0].aggregate.successRate = { count: 10, mean: 0.5, stdDev: 0.1, min: 0.3, max: 0.7 };
  render(<GridMap summary={run} activeVariantId="baseline" pointId="p0" />);
  const points = screen.getByRole(twoAxes ? "table" : "list", { name: twoAxes ? "Parameter heatmap" : "Map points" });
  const point = within(points).getAllByRole("button")[0] as HTMLButtonElement;
  expect(point.title).toContain("95% CI 42.8%–57.2%");
  act(() => setConfidenceLevel(99));
  expect(point.title).toContain("99% CI 39.7%–60.3%");
  expect(screen.getByText(/Means across replications/).textContent).toContain("99% CI");
  if (!twoAxes) expect(screen.getByRole("img", { name: "Parameter line with 99% confidence intervals" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Map metric"), { target: { value: "handlerUtilization" } });
  expect(point.title).toBe("50%");
});

function gridSummary(twoAxes = true) {
  const result = structuredClone(summary);
  result.grid = [{ path: "gateway-to-middle.timeout", values: ["80ms", "40ms", "80ms"] }];
  if (twoAxes) result.grid.push({ path: "gateway-to-middle.attempts", values: [3, 1] });
  const template = result.variants[0].points[0];
  result.variants[0].points = Array.from({ length: twoAxes ? 6 : 3 }, (_, index) => ({
    ...template, id: `p${index}`, coordinates: {}, aggregate: {
      ...template.aggregate,
      successRate: { count: 2, mean: index / 10, stdDev: 0.02, min: 0, max: 1, ci95Low: index / 10 - 0.2, ci95High: index / 10 + 0.2 },
    },
  }));
  return result;
}

describe("Map summary data", () => {
  it("places the first axis on rows, preserving unsorted values and duplicates by point ID", () => {
    const grid = gridSummary();
    const cells = gridCells(grid.grid, [...grid.variants[0].points].reverse());
    expect(cells.map((cell) => [cell.id, cell.row, cell.column, cell.point?.aggregate.successRate?.mean])).toEqual([
      ["p0", 0, 0, 0], ["p1", 0, 1, 0.1], ["p2", 1, 0, 0.2],
      ["p3", 1, 1, 0.3], ["p4", 2, 0, 0.4], ["p5", 2, 1, 0.5],
    ]);
  });

  it("keeps repeated one-axis values as distinct points and leaves absent points unavailable", () => {
    const grid = gridSummary(false);
    const cells = gridCells(grid.grid, [grid.variants[0].points[0], grid.variants[0].points[2]]);
    expect(cells.map((cell) => [cell.id, cell.row, cell.column, cell.point?.id ?? null])).toEqual([
      ["p0", 0, 0, "p0"], ["p1", 0, 1, null], ["p2", 0, 2, "p2"],
    ]);
    expect(gridCells([], grid.variants[0].points)).toEqual([]);
  });

  it("uses replication metrics and pooled service totals without clipping CI or inventing missing values", () => {
    const aggregate = gridSummary().variants[0].points[0].aggregate;
    expect(mapMetric(aggregate, "successRate", "gateway")).toMatchObject({ mean: 0, ci95Low: -0.2, ci95High: 0.2 });
    expect(mapMetric(aggregate, "p95LatencyMs", "gateway")).toEqual({ count: 2, mean: 41.25, min: 40, max: 42.5 });
    expect(mapMetric(aggregate, "p99LatencyMs", "gateway")).toEqual({ count: 2, mean: 80, min: 79, max: 81 });
    expect(mapMetric(aggregate, "admittedAmplification", "gateway")).toMatchObject({ mean: 1.2 });
    expect(mapMetric(aggregate, "handlerUtilization", "gateway")).toEqual({ mean: 0.5 });
    expect(mapMetric(aggregate, "handlerUtilization", "missing")).toBeNull();
    aggregate.services.gateway.totals.handlerCapacityTimeMs = 0;
    expect(mapMetric(aggregate, "handlerUtilization", "gateway")).toBeNull();
  });
});

it("renders the heatmap in grid order, selects points and reads service metrics from the active variant", () => {
  const grid = gridSummary();
  const onPointChange = vi.fn();
  render(<GridMap summary={grid} activeVariantId="baseline" pointId="p0" onPointChange={onPointChange} />);
  const heatmap = screen.getByRole("table", { name: "Parameter heatmap" });
  expect(within(heatmap).getAllByRole("rowheader").map((node) => node.textContent)).toEqual(["80ms", "40ms", "80ms"]);
  const cells = within(heatmap).getAllByRole("button");
  expect(cells.map((node) => node.textContent)).toEqual(["p00%", "p110%", "p220%", "p330%", "p440%", "p550%"]);
  fireEvent.click(cells[5]);
  expect(onPointChange).toHaveBeenCalledWith("p5");
  expect(screen.getByLabelText("Map color scale").textContent).toContain("50%");
  fireEvent.change(screen.getByLabelText("Map metric"), { target: { value: "handlerUtilization" } });
  expect(cells[0].textContent).toContain("50%");
  expect(screen.getByText(/pooled busy\/capacity/)).toBeTruthy();
});

it("shows every one-axis value with the selected confidence interval and point selection", () => {
  const onPointChange = vi.fn();
  render(<GridMap summary={gridSummary(false)} activeVariantId="baseline" pointId="p0" onPointChange={onPointChange} />);
  expect(screen.getByRole("img", { name: "Parameter line with 95% confidence intervals" })).toBeTruthy();
  const points = screen.getByRole("list", { name: "Map points" });
  const buttons = within(points).getAllByRole("button");
  expect(buttons).toHaveLength(3);
  expect(buttons[0].textContent).toContain("95% CI -18%–18%");
  fireEvent.click(buttons[2]);
  expect(onPointChange).toHaveBeenCalledWith("p2");
});

it("requires a variant page and never substitutes the first variant", () => {
  const view = render(<GridMap summary={gridSummary()} activeVariantId={null} pointId="p0" />);
  expect(screen.getByText("Select a variant page to view Map.")).toBeTruthy();
  view.rerender(<GridMap summary={gridSummary()} activeVariantId="no-retries" pointId="p0" />);
  expect(screen.getByRole("button", { name: /p1/ }).textContent).toContain("n/a");
});

it("formats numeric grid axis values while preserving document quantities", () => {
  const run = gridSummary();
  run.grid[1].values = [1000, 2000];
  render(<GridMap summary={run} activeVariantId="baseline" pointId="p0" />);
  const table = screen.getByRole("table", { name: "Parameter heatmap" });
  expect(within(table).getByRole("columnheader", { name: "1,000" })).toBeTruthy();
  expect(within(table).getAllByRole("rowheader")[0].textContent).toBe("80ms");
  expect(run.grid[1].values[0]).toBe(1000);
});
