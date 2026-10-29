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
  const row = within(panel).getByRole("button", { name: /At least one handler/ });
  expect(row.title).toContain("/blocks/gateway/params/handlers");
  expect(row.textContent).not.toContain("/blocks/gateway/params/handlers");
  expect(row.textContent).toContain("chain.model.json");
  expect(row.textContent).toContain("gateway");
  expect(within(panel).getByText(/No element location/)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: /At least one handler/ }).textContent).toContain("baseline");
  fireEvent.click(within(panel).getByRole("button", { name: /At least one handler/ }));
  expect(onDiagnostic).toHaveBeenCalledWith(finding);
});

it("uses the shared point without offering another context selector in Answer or Timeline", () => {
  const grid = structuredClone(summary);
  grid.grid = [{ path: "gateway-to-middle.timeout", values: ["40ms", "80ms"] }];
  const point = grid.variants[0].points[0];
  grid.variants[0].points = [
    { ...point, id: "p0", coordinates: { "gateway-to-middle.timeout": "40ms" } },
    { ...point, id: "p1", coordinates: { "gateway-to-middle.timeout": "80ms" } },
  ];
  const onPointChange = vi.fn();
  const view = render(<ResultsPanel job={null} summary={grid} problem={null} selectedPointId="p0" onPointChange={onPointChange} />);
  expect(screen.queryByRole("combobox", { name: "Grid point" })).toBeNull();
  view.rerender(<ResultsPanel job={null} summary={grid} problem={null} selectedPointId="p1" onPointChange={onPointChange} />);
  expect(screen.getByRole("region", { name: "Saturation insight" }).textContent).toContain("p1");
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  expect(screen.queryByRole("combobox", { name: "Grid point" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Replication" })).toBeNull();
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

it("collapses and expands while preserving tabs", () => {
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
  expect(screen.queryByText(/RUNNING/)).toBeNull();

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

it("orders errors before warnings while preserving response order within each severity", () => {
  const diagnostic = { code: "TEST", document: null, pointer: null, path: null };
  render(<ResultsPanel job={null} summary={null} problem={null} diagnostics={[
    { ...diagnostic, severity: "WARNING", message: "First warning" },
    { ...diagnostic, severity: "ERROR", message: "First error" },
    { ...diagnostic, severity: "WARNING", message: "Second warning" },
    { ...diagnostic, severity: "ERROR", message: "Second error" },
  ]} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  const rows = within(screen.getByRole("tabpanel")).getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector(".diagnostic-message")?.textContent))
    .toEqual(["First error", "Second error", "First warning", "Second warning"]);
  expect(within(rows[0]).getByRole("img", { name: "Error" })).toBeTruthy();
  expect(within(rows[2]).getByRole("img", { name: "Warning" })).toBeTruthy();
});

it("keeps diagnostic pointers out of API error banners on every tab", () => {
  const finding = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "At least one handler", document: "chain.model.json",
    pointer: "/blocks/gateway/params/handlers", path: "gateway" };
  render(<ResultsPanel job={null} summary={null} problem={{ code: "INVALID_MODEL", message: "Run rejected", diagnostics: [finding] }}
    diagnostics={[finding]} />);
  expect(screen.getByRole("alert").textContent).not.toContain(finding.pointer);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  const row = screen.getByRole("button", { name: /At least one handler/ });
  expect(row.title).toContain(finding.pointer);
  expect(row.textContent).not.toContain(finding.pointer);
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

it.each([false, true])("keeps a Problems request ahead of completion navigation: requested during run=%s", duringRun => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running />);
  if (duringRun) view.rerender(<ResultsPanel job={null} summary={null} problem={null} running problemsRequest={1} />);
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} problemsRequest={1} />);
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Answer" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={structuredClone(summary)} problem={null} running={false} problemsRequest={1} />);
  expect(screen.getByRole("tab", { name: "Answer" }).getAttribute("aria-selected")).toBe("true");
});
