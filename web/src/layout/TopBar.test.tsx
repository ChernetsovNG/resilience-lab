import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar, type TopBarProps } from "./TopBar";

function props(overrides: Partial<TopBarProps> = {}): TopBarProps {
  return { experiments: ["first.experiment.json", "second.experiment.json"], experiment: "first.experiment.json",
    onExperiment: vi.fn(), loading: false, dirty: false, invalid: false, conflict: false, saving: false,
    onSave: vi.fn(), running: false, onRun: vi.fn(), job: null, health: null, healthError: null, ...overrides };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

describe("TopBar", () => {
  it.each(["loading", "saving", "running", "invalid"] as const)("prevents experiment switching while %s", (flag) => {
    render(<TopBar {...props({ [flag]: true })} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Experiment" }).disabled).toBe(true);
  });

  it.each(["invalid", "saving", "loading", "conflict"] as const)("prevents saving dirty edits while %s", (flag) => {
    const state = props({ dirty: true, [flag]: true });
    render(<TopBar {...state} />);
    expect(button("Save").disabled).toBe(true);
    fireEvent.click(button("Save"));
    expect(state.onSave).not.toHaveBeenCalled();
  });

  it("allows saving valid edits but requires saving before running", () => {
    const state = props({ dirty: true });
    render(<TopBar {...state} />);
    expect(button("Save").disabled).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(button("Run").disabled).toBe(true);
    fireEvent.click(button("Save"));
    expect(state.onSave).toHaveBeenCalledOnce();
  });

  it.each(["invalid", "loading", "running"] as const)("prevents running while %s", (flag) => {
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
});
