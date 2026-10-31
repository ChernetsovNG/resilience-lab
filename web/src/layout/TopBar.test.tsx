import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar, type TopBarProps } from "./TopBar";

function props(overrides: Partial<TopBarProps> = {}): TopBarProps {
  return { models: ["first.model.json", "second.model.json"], model: "first.model.json", onModel: vi.fn(), onNewModel: vi.fn(), onNewExperiment: vi.fn(), runSettingsPressed: false,
    experiments: ["first.experiment.json", "second.experiment.json"], experiment: "first.experiment.json",
    onExperiment: vi.fn(), onInspectExperiment: vi.fn(), loading: false, dirty: false, invalid: false, conflict: false, saving: false,
    canUndo: false, canRedo: false, onUndo: vi.fn(), onRedo: vi.fn(), onSave: vi.fn(), running: false, onRun: vi.fn(), estimating: false, onEstimate: vi.fn(), canResume: false, onResume: vi.fn(), onCancel: vi.fn(), job: null, ...overrides };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

describe("TopBar", () => {
  it("shows document names while preserving file paths as selection values", () => {
    render(<TopBar {...props()} />);
    const experiment = screen.getByRole<HTMLSelectElement>("combobox", { name: "Experiment" });
    expect(experiment.selectedOptions[0].textContent).toBe("first");
    expect(experiment.value).toBe("first.experiment.json");
  });
  it("blocks running with a validation explanation", () => {
    const state = props({ runBlockedReason: "Fix validation errors before running" });
    render(<TopBar {...state} />);
    expect(button("Run").disabled).toBe(true);
    expect(button("Run").title).toBe("Fix validation errors before running");
    fireEvent.click(button("Run"));
    expect(state.onRun).not.toHaveBeenCalled();
  });
  it.each(["loading", "saving", "running", "invalid"] as const)("prevents experiment switching while %s", (flag) => {
    render(<TopBar {...props({ [flag]: true })} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Experiment" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" }).disabled).toBe(true);
  });

  it.each(["invalid", "saving", "loading", "conflict"] as const)("prevents saving dirty edits while %s", (flag) => {
    const state = props({ dirty: true, [flag]: true });
    render(<TopBar {...state} />);
    expect(button("Save").disabled).toBe(true);
    fireEvent.click(button("Save"));
    expect(state.onSave).not.toHaveBeenCalled();
  });

  it("allows running with valid unsaved edits", () => {
    const state = props({ dirty: true });
    render(<TopBar {...state} />);
    expect(button("Save").disabled).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(button("Run").disabled).toBe(false);
    fireEvent.click(button("Save"));
    expect(state.onSave).toHaveBeenCalledOnce();
  });

  it("advertises save and run shortcuts in button tooltips", () => {
    render(<TopBar {...props({ dirty: true })} />);
    expect(button("Save").title).toContain("Ctrl/Cmd+S");
    expect(button("Run").title).toContain("Ctrl/Cmd+Enter");
  });

  it.each(["invalid", "loading", "running", "saving"] as const)("prevents running while %s", (flag) => {
    const state = props({ [flag]: true });
    render(<TopBar {...state} />);
    expect(button("Run").disabled).toBe(true);
    fireEvent.click(button("Run"));
    expect(state.onRun).not.toHaveBeenCalled();
  });

  it("prevents running without an experiment", () => {
    render(<TopBar {...props({ experiment: null })} />);
    expect(button("Run").disabled).toBe(true);
  });

  it("allows running a clean valid experiment and switching when idle", () => {
    const state = props();
    render(<TopBar {...state} />);
    expect(button("Save").disabled).toBe(true);
    expect(button("Run").disabled).toBe(false);
    fireEvent.click(button("Run"));
    expect(state.onRun).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("combobox", { name: "Experiment" }), { target: { value: "second.experiment.json" } });
    expect(state.onExperiment).toHaveBeenCalledWith("second.experiment.json");
  });

  it.each(["QUEUED", "RUNNING"] as const)("cancels a %s job", (status) => {
    const state = props({ running: true, job: {
      id: "job-1", experiment: "first.experiment.json", runId: "run-1", status,
      completedTasks: 0, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
    } });
    render(<TopBar {...state} />);
    fireEvent.click(button("Cancel"));
    expect(state.onCancel).toHaveBeenCalledOnce();
  });

  it("shows cancellation requested and disables another cancellation", () => {
    render(<TopBar {...props({ running: true, job: {
      id: "job-1", experiment: "first.experiment.json", runId: "run-1", status: "RUNNING",
      completedTasks: 1, totalTasks: 4, cancelRequested: true, error: null, diagnostics: [],
    } })} />);
    expect(button("Cancel").disabled).toBe(true);
    expect(screen.queryByTestId("job-status")).toBeNull();
  });

  it("does not offer cancellation for a terminal job", () => {
    render(<TopBar {...props({ job: {
      id: "job-1", experiment: "first.experiment.json", runId: "run-1", status: "COMPLETED",
      completedTasks: 4, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
    } })} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});


it.each(["invalid", "loading"] as const)("blocks undo and redo while %s", (flag) => {
  render(<TopBar {...props({ canUndo: true, canRedo: true, [flag]: true })} />);
  expect(button("Undo").disabled).toBe(true);
  expect(button("Redo").disabled).toBe(true);
});

it.each(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const)("keeps %s status out of the top bar", (status) => {
  render(<TopBar {...props({ job: {
    id: "job-1", experiment: "first.experiment.json", runId: "run-1", status,
    completedTasks: 0, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
  } })} />);

  expect(screen.queryByTestId("job-status")).toBeNull();
  expect(screen.queryByText(/Checking backend/)).toBeNull();
});
