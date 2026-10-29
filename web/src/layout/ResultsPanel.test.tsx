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
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Answer" }).id);
  expect(screen.getByRole("table", { name: "Answer" })).toBeTruthy();
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
  expect(screen.queryByRole("table", { name: "Answer" })).toBeNull();
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
  expect(screen.getByRole("tab", { name: "Answer" })).toBeTruthy();
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

it("formats numeric coordinates in the point selector without changing its values", () => {
  const run = structuredClone(summary);
  run.grid = [{ path: "gateway.handlers", values: [1000] }];
  run.variants[0].points[0].coordinates = { "gateway.handlers": 1000 };
  render(<ResultsPanel job={null} summary={run} problem={null} />);
  const selector = screen.getByRole("combobox", { name: "Grid point" });
  expect(within(selector).getByRole("option", { name: /gateway.handlers = 1,000/ })).toBeTruthy();
  expect(run.grid[0].values[0]).toBe(1000);
});

const runJob = (status: "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED", id = "job-1") => ({
  id, experiment: "chain.experiment.json", runId: `run-${id}`, status,
  completedTasks: status === "COMPLETED" ? 4 : 1, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
});

it("opens Answer after success even when Problems was selected before Run", () => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running={false} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  view.rerender(<ResultsPanel job={null} summary={null} problem={null} running />);
  view.rerender(<ResultsPanel job={runJob("RUNNING")} summary={null} problem={null} running />);
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} />);
  expect(screen.getByRole("tab", { name: "Answer" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Assumptions" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={structuredClone(summary)} problem={null} running={false} />);
  expect(screen.getByRole("tab", { name: "Assumptions" }).getAttribute("aria-selected")).toBe("true");
});

it("opens Answer for a run that completes without an intermediate running render", () => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} />);
  expect(screen.getByRole("tab", { name: "Answer" }).getAttribute("aria-selected")).toBe("true");
});

it.each(["submission", "execution"])("keeps the tab selected during %s and resets the preference for the next run", phase => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running={false} />);
  view.rerender(<ResultsPanel job={phase === "submission" ? null : runJob("RUNNING")} summary={null} problem={null} running />);
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  view.rerender(<ResultsPanel job={runJob("RUNNING")} summary={null} problem={null} running />);
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} />);
  expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
  view.rerender(<ResultsPanel job={null} summary={null} problem={null} running />);
  view.rerender(<ResultsPanel job={runJob("COMPLETED", "job-2")} summary={summary} problem={null} running={false} />);
  expect(screen.getByRole("tab", { name: "Answer" }).getAttribute("aria-selected")).toBe("true");
});

it("restores a collapsed panel once after success while preserving a manual tab choice", () => {
  const onSizeChange = vi.fn();
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running size="collapsed" onSizeChange={onSizeChange} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} size="collapsed" onSizeChange={onSizeChange} />);
  expect(onSizeChange).toHaveBeenCalledExactlyOnceWith("normal");
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={structuredClone(summary)} problem={null} running={false} size="collapsed" onSizeChange={onSizeChange} />);
  expect(onSizeChange).toHaveBeenCalledTimes(1);
});

it.each(["CANCELLED", "FAILED"] as const)("keeps the tab and collapsed size after %s", status => {
  const onSizeChange = vi.fn();
  const view = render(<ResultsPanel job={runJob("RUNNING")} summary={null} problem={null} running size="collapsed" onSizeChange={onSizeChange} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  view.rerender(<ResultsPanel job={runJob(status)} summary={null} problem={null} running={false} size="collapsed" onSizeChange={onSizeChange} />);
  expect(onSizeChange).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
});

it("offers selected points present only in a later variant", () => {
  const run = structuredClone(summary);
  run.grid = [{ path: "gateway.handlers", values: [4, 6] }];
  run.variants[1].points.push({ ...run.variants[1].points[0], id: "p1", coordinates: { "gateway.handlers": 6 } });
  render(<ResultsPanel job={null} summary={run} problem={null} selectedPointId="p1" />);
  expect(within(screen.getByRole("combobox", { name: "Grid point" })).getByRole("option", { name: /p1.*gateway.handlers = 6/ })).toBeTruthy();
});
