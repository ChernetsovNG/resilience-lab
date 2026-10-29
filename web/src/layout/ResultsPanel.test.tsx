import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { summary } from "../test/fixtures";
import { ResultsPanel } from "./ResultsPanel";

it("offers Timeline and explains that it needs a run", () => {
  render(<ResultsPanel job={null} summary={null} problem={null} />);
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("Run the experiment to see the timeline.");
});

it("offers Map only for the summary grid and returns to Summary after a run without a grid", async () => {
  const grid = structuredClone(summary);
  grid.grid = [{ path: "gateway-to-middle.timeout", values: ["80ms"] }];
  const view = render(<ResultsPanel job={null} summary={grid} problem={null} activeVariantId="baseline" />);
  fireEvent.click(screen.getByRole("tab", { name: "Map" }));
  expect(await screen.findByRole("list", { name: "Map points" })).toBeTruthy();
  view.rerender(<ResultsPanel job={null} summary={summary} problem={null} activeVariantId="baseline" />);
  expect(screen.queryByRole("tab", { name: "Map" })).toBeNull();
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Summary" }).id);
  expect(screen.getByRole("table", { name: "Summary" })).toBeTruthy();
});

it("lists all diagnostics in Problems and navigates from a finding", () => {
  const finding = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "At least one handler", document: "chain.model.json", pointer: "/blocks/gateway/params/handlers", path: "gateway", variant: "baseline" };
  const onDiagnostic = vi.fn();
  render(<ResultsPanel job={null} summary={null} problem={null} diagnostics={[
    finding, { code: "MODEL_EMPTY", severity: "WARNING", message: "No element location", document: null, pointer: null, path: null },
  ]} onDiagnostic={onDiagnostic} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  const panel = screen.getByRole("tabpanel");
  expect(within(panel).getByText(/chain.model.json#\/blocks\/gateway\/params\/handlers/)).toBeTruthy();
  expect(within(panel).getByText(/No element location/)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: /At least one handler/ }).textContent).toContain("baseline");
  fireEvent.click(within(panel).getByRole("button", { name: /At least one handler/ }));
  expect(onDiagnostic).toHaveBeenCalledWith(finding);
});

it("selects a grid point by ID and coordinates, but hides the selector without a grid", () => {
  const grid = structuredClone(summary);
  grid.grid = [{ path: "gateway-to-middle.timeout", values: ["40ms", "80ms"] }];
  const point = grid.variants[0].points[0];
  grid.variants[0].points = [
    { ...point, id: "p0", coordinates: { "gateway-to-middle.timeout": "40ms" } },
    { ...point, id: "p1", coordinates: { "gateway-to-middle.timeout": "80ms" } },
  ];
  const onPointChange = vi.fn();
  const view = render(<ResultsPanel job={null} summary={grid} problem={null} selectedPointId="p0" onPointChange={onPointChange} />);
  const selector = screen.getByRole("combobox", { name: "Grid point" });
  expect(within(selector).getByRole("option", { name: /p0.*gateway-to-middle\.timeout = 40ms/ })).toBeTruthy();
  expect(within(selector).getByRole("option", { name: /p1.*gateway-to-middle\.timeout = 80ms/ })).toBeTruthy();

  fireEvent.change(selector, { target: { value: "p1" } });
  expect(onPointChange).toHaveBeenCalledWith("p1");

  view.rerender(<ResultsPanel job={null} summary={summary} problem={null} selectedPointId="p0" onPointChange={onPointChange} />);
  expect(screen.queryByRole("combobox", { name: "Grid point" })).toBeNull();
});

it("explains that a cancelled run is incomplete and has no summary", () => {
  render(<ResultsPanel job={{
    id: "job-1", experiment: "chain.experiment.json", runId: "run-1", status: "CANCELLED",
    completedTasks: 1, totalTasks: 4, cancelRequested: true, error: null, diagnostics: [],
  }} summary={null} problem={null} />);

  expect(screen.getByText("Run cancelled; the run is incomplete and has no summary.")).toBeTruthy();
  expect(screen.queryByRole("table", { name: "Summary" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("collapses and expands while preserving tabs and job status", () => {
  const onSizeChange = vi.fn();
  const running = {
    id: "job-1", experiment: "chain.experiment.json", runId: "run-1", status: "RUNNING" as const,
    completedTasks: 1, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
  };
  const panel = (size: "collapsed" | "normal" | "expanded") =>
    <ResultsPanel job={running} summary={null} problem={null} size={size} onSizeChange={onSizeChange} />;
  const view = render(panel("normal"));

  fireEvent.click(screen.getByRole("button", { name: "Collapse results" }));
  expect(onSizeChange).toHaveBeenCalledWith("collapsed");
  view.rerender(panel("collapsed"));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
  expect(screen.getByTestId("results-job-status").textContent).toContain("RUNNING");

  fireEvent.click(screen.getByRole("button", { name: "Restore results" }));
  expect(onSizeChange).toHaveBeenCalledWith("normal");
  view.rerender(panel("normal"));
  fireEvent.click(screen.getByRole("button", { name: "Expand results" }));
  expect(onSizeChange).toHaveBeenCalledWith("expanded");
  view.rerender(panel("expanded"));
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore results" }));
  expect(onSizeChange).toHaveBeenCalledWith("normal");
});
