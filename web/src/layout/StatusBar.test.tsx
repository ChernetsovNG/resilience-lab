import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JobView } from "../api/apiTypes";
import { StatusBar, type StatusBarProps } from "./StatusBar";

const job: JobView = {
  id: "job-1", experiment: "chain.experiment.json", runId: "run-1", status: "RUNNING",
  completedTasks: 3, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
};
const props: StatusBarProps = {
  job: null, health: { status: "UP", applicationVersion: "1.2.3", kslVersion: "R1.3.1" },
  healthError: null, diagnostics: [], stale: false, cursorMs: null, zoom: null, onProblems: () => {},
};
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["QUEUED", "QUEUED 3/4"], ["RUNNING", "RUNNING 3/4"],
  ["COMPLETED", "COMPLETED"], ["CANCELLED", "CANCELLED"], ["FAILED", "FAILED"],
] as const)("shows %s in the status bar", (status, expected) => {
  render(<StatusBar {...props} job={{ ...job, status }} />);
  expect(screen.getByTestId("job-status").textContent).toBe(expected);
});

it("shows cancellation requests and an unknown task total", () => {
  render(<StatusBar {...props} job={{ ...job, totalTasks: 0, cancelRequested: true }} />);
  expect(screen.getByTestId("job-status").textContent).toBe("RUNNING 3/? · cancellation requested");
});

it("renders an unknown API status in production without crashing", () => {
  vi.stubEnv("DEV", false);
  vi.stubEnv("MODE", "production");
  render(<StatusBar {...props} job={{ ...job, status: "PAUSED" as JobView["status"] }} />);
  expect(screen.getByTestId("job-status").textContent).toBe("PAUSED");
});

it("shows diagnostic counts, stale results, cursor time, backend version and canvas zoom", () => {
  const onProblems = vi.fn();
  const warning = { code: "LINT", severity: "WARNING" as const, message: "Budget", document: null, pointer: null, path: null };
  const view = render(<StatusBar {...props} diagnostics={[warning, { ...warning, code: "RANGE", severity: "ERROR" }, warning]}
    stale cursorMs={1200} zoom={0.657} onProblems={onProblems} />);
  fireEvent.click(screen.getByRole("button", { name: "Errors: 1 · Warnings: 2" }));
  expect(onProblems).toHaveBeenCalledOnce();
  expect(screen.getByText("Results outdated")).toBeTruthy();
  expect(screen.getByText("Cursor 1,200 ms")).toBeTruthy();
  expect(screen.getByText("Zoom 65.7%")).toBeTruthy();
  expect(screen.getByText("Backend healthy · v1.2.3 · KSL R1.3.1")).toBeTruthy();
  view.rerender(<StatusBar {...props} />);
  expect(screen.queryByText(/Cursor/)).toBeNull();
  expect(screen.queryByText(/Zoom/)).toBeNull();
  expect(screen.queryByText("Results outdated")).toBeNull();
});

it("keeps backend checking and failure visible", () => {
  const view = render(<StatusBar {...props} health={null} />);
  expect(screen.getByText("Checking backend health…")).toBeTruthy();
  view.rerender(<StatusBar {...props} healthError="Offline" />);
  expect(screen.getByRole("alert").textContent).toBe("Backend unavailable: Offline");
});
