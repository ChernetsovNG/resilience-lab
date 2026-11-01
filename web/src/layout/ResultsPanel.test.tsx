import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { catalog, experiment, model, summary } from "../test/fixtures";
import { ResultsPanel, type ResultsPanelSize } from "./ResultsPanel";
import { DiagnosticLabelContext } from "../presentation/diagnosticContext";

it("shows connection endpoints in Problems while preserving navigation and filter ids", () => {
  const finding = { code: "CUSTOM_WARNING", severity: "WARNING" as const, message: "Inspect this connection", path: "gateway-to-middle" };
  const onDiagnostic = vi.fn();
  render(<ResultsPanel job={null} summary={null} problem={null} model={model} diagnostics={[finding]}
    problemsElement="gateway-to-middle" onDiagnostic={onDiagnostic} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  const row = screen.getByRole("button", { name: /Inspect this connection/ });
  expect(row.querySelector(".diagnostic-context")!.textContent).toContain("gateway → middle (gateway-to-middle)");
  expect(document.querySelector(".problems-filter")!.textContent).toContain("gateway → middle (gateway-to-middle)");
  fireEvent.click(row);
  expect(onDiagnostic).toHaveBeenCalledWith(finding);
});

it("groups equivalent linter rows, counts groups and keeps formulas and rule codes in help", () => {
  const onDiagnostic = vi.fn();
  const findings = ["baseline", "pool"].flatMap(variant => [1, 2, 3].map(replica => ({
    code: "LINT_HANDLERS_LITTLE", severity: "WARNING" as const, message: "Capacity warning", path: `catalog#${replica}`,
    document: "test.model.json", pointer: "/blocks/catalog/params/handlers", variant,
    args: { elementType: "service", handlers: 16, demand: 31.5, ratePerSecond: 900, holdingMs: 35, replica, service: "catalog" },
  })));
  render(<ResultsPanel job={null} summary={null} problem={null} diagnostics={findings} onDiagnostic={onDiagnostic}
    experiment={{ ...experiment, variants: [{ id: "baseline", label: "Baseline", overrides: {} }, { id: "pool", label: "Pool 16", overrides: {} }] }} />);
  const tab = screen.getByRole("tab", { name: "Problems" });
  expect(tab.textContent).toContain("1");
  fireEvent.click(tab);
  const rows = screen.getByRole("tabpanel").querySelectorAll(".validation-problems > li");
  expect(rows).toHaveLength(1);
  const navigation = rows[0].querySelector("button")!;
  expect(navigation.textContent).toContain("#1–#3");
  expect(navigation.textContent).toContain("Baseline, Pool 16");
  expect(navigation.textContent).not.toMatch(/LINT_|λ|λ·W/);
  fireEvent.click(navigation);
  expect(onDiagnostic).toHaveBeenCalledWith(findings[0]);
  fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: /How this warning is calculated/ }));
  expect(screen.getByRole("tooltip").textContent).toContain("LINT_HANDLERS_LITTLE");
  expect(screen.getByRole("tooltip").textContent).toContain("λ·W");
});

it("formats run errors with their saved grid and variants rather than the current editor context", () => {
  render(<DiagnosticLabelContext value={{ catalog, model, variants: [{ id: "variant-2", label: "Current label" }],
    grid: [{ path: "gateway.processing.mean", values: ["99ms", "100ms"] }] }}>
    <ResultsPanel job={null} summary={null} model={model} catalog={catalog}
      experiment={{ ...experiment, variants: [{ id: "variant-2", label: "Recorded label", overrides: {} }],
        grid: [{ path: "gateway.processing.mean", values: ["3ms", "4ms"] }] }}
      problem={{ code: "EXECUTION_DRAIN", message: "Incomplete workload", args: { variant: "variant-2", point: "p1", replication: 3 }, diagnostics: [] }} />
  </DiagnosticLabelContext>);
  const error = screen.getByRole("alert");
  expect(error.textContent).toContain("Variant 'Recorded label', point 'Processing time · Mean · gateway = 4 ms'");
  expect(error.textContent).not.toMatch(/Current label|100 ms|p1|variant-2/);
});

it("preserves a deliberately entered variant label even when it resembles a generated ID", () => {
  const run = structuredClone(summary);
  run.variants = [{ ...run.variants[0], id: "variant-2", label: "variant-2" }];
  render(<ResultsPanel job={null} summary={run} problem={null} activeVariantId="variant-2"
    experiment={{ ...experiment, variants: [{ id: "variant-2", label: "variant-2", overrides: {} }] }} />);
  expect(within(screen.getByRole("table", { name: "Findings" })).getAllByRole("columnheader")[1].textContent).toContain("variant-2");
});

it("uses variant labels and catalog coordinates in Problems, keeping the code secondary", () => {
  const finding = { code: "CUSTOM_GRID_WARNING", severity: "WARNING" as const,
    message: "Capacity at gateway.handlers needs attention (points: p1)", args: { points: "p1" },
    document: "test.experiment.json", path: "gateway", variant: "variant-2" };
  render(<ResultsPanel job={null} summary={null} problem={null} catalog={catalog} model={model}
    experiment={{ ...experiment, variants: [{ id: "variant-2", overrides: {} }], grid: [{ path: "gateway.handlers", values: [4, 6] }] }}
    diagnostics={[finding]} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  const row = screen.getByRole("button", { name: /Capacity/ });
  expect(row.querySelector(".diagnostic-message")!.textContent).toContain("Handlers · gateway = 6");
  expect(row.querySelector(".diagnostic-context")!.textContent).toContain("Variant 2");
  expect(row.textContent).not.toMatch(/p1|variant-2|gateway\.handlers/);
  expect(row.querySelector(".diagnostic-details")!.textContent).toContain("CUSTOM_GRID_WARNING");
});

it("offers Timeline and explains that it needs a run", () => {
  render(<ResultsPanel job={null} summary={null} problem={null} />);
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("Run the experiment to see the timeline.");
});

it("shows waiting instead of an invitation to run while the first run is starting", () => {
  render(<ResultsPanel job={null} summary={null} problem={null} running />);
  expect(screen.getByRole("tabpanel").textContent).toContain("Waiting for run results.");
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("Waiting for run results.");
  expect(screen.queryByText("Run the experiment to see the timeline.")).toBeNull();
});

it("offers Map only for the summary grid and returns to Summary after a run without a grid", async () => {
  const grid = structuredClone(summary);
  grid.grid = [{ path: "gateway-to-middle.timeout", values: ["80ms"] }];
  const view = render(<ResultsPanel job={null} summary={grid} problem={null} activeVariantId="baseline" />);
  fireEvent.click(screen.getByRole("tab", { name: "Map" }));
  expect(await screen.findByRole("list", { name: "Map points" })).toBeTruthy();
  view.rerender(<ResultsPanel job={null} summary={summary} problem={null} activeVariantId="baseline" />);
  expect(screen.queryByRole("tab", { name: "Map" })).toBeNull();
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Findings" }).id);
  expect(screen.getByRole("table", { name: "Findings" })).toBeTruthy();
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
  expect(within(panel).getByRole("button", { name: /At least one handler/ }).textContent).toContain("Baseline");
  fireEvent.click(within(panel).getByRole("button", { name: /At least one handler/ }));
  expect(onDiagnostic).toHaveBeenCalledWith(finding);
});

it("uses the shared point without offering another context selector in Findings or Timeline", () => {
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
  expect(screen.getByRole("region", { name: "Saturation insight" }).textContent).toContain("Timeout · gateway-to-middle = 80 ms");
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
  expect(screen.queryByRole("table", { name: "Findings" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("collapses and restores while preserving tabs", () => {
  const onSizeChange = vi.fn();
  const running = {
    id: "job-1", experiment: "chain.experiment.json", runId: "run-1", status: "RUNNING" as const,
    completedTasks: 1, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
  };
  const panel = (size: "collapsed" | "normal") =>
    <ResultsPanel job={running} summary={null} problem={null} size={size} onSizeChange={onSizeChange} />;
  const view = render(panel("normal"));

  fireEvent.click(screen.getByRole("button", { name: "Collapse results" }));
  expect(onSizeChange).toHaveBeenCalledWith("collapsed");
  view.rerender(panel("collapsed"));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByRole("tab", { name: "Findings" })).toBeTruthy();
  expect(screen.queryByText(/RUNNING/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Expand results" }));
  expect(onSizeChange).toHaveBeenCalledWith("normal");
  view.rerender(panel("normal"));
  expect(screen.queryByRole("button", { name: "Expand results" })).toBeNull();
  expect(screen.getByRole("tabpanel")).toBeTruthy();
});

it("expands results and restores their size without changing the selected tab", () => {
  function Panel() {
    const [size, setSize] = useState<ResultsPanelSize>("normal");
    return <ResultsPanel job={null} summary={null} problem={null} size={size} onSizeChange={setSize} />;
  }
  render(<Panel />);
  const tab = screen.getByRole("tab", { name: "Assumptions" });
  fireEvent.click(tab);
  fireEvent.click(screen.getByRole("button", { name: "Maximize results" }));
  expect(screen.getByRole("region", { name: "Results" }).classList.contains("results-panel--expanded")).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  expect(screen.getByRole("region", { name: "Results" }).classList.contains("results-panel--expanded")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Restore results size" }));
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("region", { name: "Results" }).classList.contains("results-panel--normal")).toBe(true);
});

it.each(["Findings", "Timeline", "Assumptions", "Map", "Problems"])("opens collapsed %s and keeps it open on repeated selection", async name => {
  const grid = structuredClone(summary);
  grid.grid = [{ path: "gateway-to-middle.timeout", values: ["80ms"] }];
  function Panel() {
    const [size, setSize] = useState<ResultsPanelSize>("collapsed");
    return <ResultsPanel job={null} summary={grid} problem={null} activeVariantId="baseline" size={size} onSizeChange={setSize} />;
  }
  render(<Panel />);
  expect(screen.queryByRole("tabpanel")).toBeNull();
  const tab = screen.getByRole("tab", { name });
  fireEvent.click(tab);
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tab.id);
  if (name === "Map") expect(await screen.findByRole("list", { name: "Map points" })).toBeTruthy();

  fireEvent.click(tab);
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Collapse results" }));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(tab);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tab.id);
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

it("opens Findings after success even when Problems was selected before Run", () => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running={false} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  view.rerender(<ResultsPanel job={null} summary={null} problem={null} running />);
  view.rerender(<ResultsPanel job={runJob("RUNNING")} summary={null} problem={null} running />);
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} />);
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Assumptions" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={structuredClone(summary)} problem={null} running={false} />);
  expect(screen.getByRole("tab", { name: "Assumptions" }).getAttribute("aria-selected")).toBe("true");
});

it("opens Findings for a run that completes without an intermediate running render", () => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} />);
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
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
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
});

it("preserves a manually collapsed panel after success and keeps the chosen tab", () => {
  const onSizeChange = vi.fn();
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running size="normal" onSizeChange={onSizeChange} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(screen.getByRole("button", { name: "Collapse results" }));
  onSizeChange.mockClear();
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} size="collapsed" onSizeChange={onSizeChange} />);
  expect(onSizeChange).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={structuredClone(summary)} problem={null} running={false} size="collapsed" onSizeChange={onSizeChange} />);
  expect(onSizeChange).not.toHaveBeenCalled();
});

it.each(["CANCELLED", "FAILED"] as const)("keeps the tab and collapsed size after %s", status => {
  const onSizeChange = vi.fn();
  const view = render(<ResultsPanel job={runJob("RUNNING")} summary={null} problem={null} running size="normal" onSizeChange={onSizeChange} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(screen.getByRole("button", { name: "Collapse results" }));
  onSizeChange.mockClear();
  view.rerender(<ResultsPanel job={runJob(status)} summary={null} problem={null} running={false} size="collapsed" onSizeChange={onSizeChange} />);
  expect(onSizeChange).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
});

it.each([false, true])("keeps a Problems request ahead of completion navigation: requested during run=%s", duringRun => {
  const view = render(<ResultsPanel job={null} summary={null} problem={null} running />);
  if (duringRun) view.rerender(<ResultsPanel job={null} summary={null} problem={null} running problemsRequest={1} />);
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={summary} problem={null} running={false} problemsRequest={1} />);
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  view.rerender(<ResultsPanel job={runJob("COMPLETED")} summary={structuredClone(summary)} problem={null} running={false} problemsRequest={1} />);
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
});


it("opens Timeline from the inspector request and preserves later tab choices", () => {
  const props = { job: null, summary: null, problem: null };
  const view = render(<ResultsPanel {...props} timelineRequest={0} />);
  view.rerender(<ResultsPanel {...props} timelineRequest={1} />);
  expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  view.rerender(<ResultsPanel {...props} timelineRequest={1} />);
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  view.rerender(<ResultsPanel {...props} timelineRequest={2} />);
  expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
});

it("shows the submitted load and faults above the Findings using variant and point overrides", async () => {
  const { catalog, model, experiment } = await import("../test/fixtures");
  const run = structuredClone(experiment);
  run.variants[0].overrides = { "client.load.points": [{ time: "0s", rate: "30/s" }] };
  const result = structuredClone(summary);
  result.variants[0].points.push({ ...structuredClone(result.variants[0].points[0]), id: "p1", coordinates: { "client.load.points": [{ time: "0s", rate: "90/s" }] } });
  const view = render(<ResultsPanel job={null} summary={result} problem={null} catalog={catalog} model={model} experiment={run} activeVariantId="baseline" selectedPointId="p0" />);
  expect(screen.getByTestId("run-conditions").textContent).toBe("Load 30 RPS; faults: dependency · Slowdown 6× · 200–700 ms");
  view.rerender(<ResultsPanel job={null} summary={result} problem={null} catalog={catalog} model={model} experiment={run} activeVariantId="baseline" selectedPointId="p1" />);
  expect(screen.getByTestId("run-conditions").textContent).toContain("Load 90 RPS");
  view.rerender(<ResultsPanel job={null} summary={result} problem={null} catalog={catalog} model={model} experiment={run} />);
  expect(screen.getByTestId("run-conditions").textContent).toContain("Load 30 RPS");
});
