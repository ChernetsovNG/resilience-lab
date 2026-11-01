import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, experiment, model } from "../test/fixtures";
import { ExperimentCourse } from "./ExperimentCourse";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const props = { model, experiment, catalog, onFault: vi.fn() };
const openCourse = () => fireEvent.click(screen.getByRole("button", { name: "Experiment course" }));

it("shows phases, intensity and timed faults from the document before a run", () => {
  const onFault = vi.fn();
  const run = { ...experiment, execution: { ...experiment.execution, warmup: "100ms" } };
  const { container } = render(<ExperimentCourse {...props} experiment={run} onFault={onFault} />);
  expect(screen.getByRole("button", { name: "Experiment course" }).getAttribute("aria-expanded")).toBe("false");
  openCourse();
  expect(container.querySelector('[data-phase="warmup"]')?.getAttribute("data-to-ms")).toBe("100");
  expect(container.querySelector('[data-phase="measurement"]')?.getAttribute("data-to-ms")).toBe("1100");
  expect(screen.getByRole("img", { name: "client: arrival intensity" })).toBeTruthy();
  expect(screen.getAllByText("120 RPS").length).toBeGreaterThan(0);
  const fault = screen.getByRole("button", { name: "Service dependency · Slowdown 6× · 200–700 ms" });
  expect(fault.querySelector<HTMLElement>(".course-fault-interval")!.style.left).toBe("18.181818181818183%");
  fireEvent.click(fault);
  expect(onFault).toHaveBeenCalledWith(0);
  expect(screen.queryByRole("slider")).toBeNull();
});

it("shows every profile breakpoint and reuses the selected result window for seeking", () => {
  const draft = structuredClone(model);
  draft.blocks.client.params.load = { points: [{ time: "0s", rate: "10/s" }, { time: "500ms", rate: "90/s" }] };
  const onCursorChange = vi.fn();
  const view = render(<ExperimentCourse {...props} model={draft} windowMs={100} cursorWindow={4} onCursorChange={onCursorChange} />);
  openCourse();
  expect(screen.getByText("10 RPS")).toBeTruthy();
  expect(screen.getAllByText("90 RPS").length).toBeGreaterThan(0);
  const axis = screen.getByRole("slider", { name: "Experiment time" });
  vi.spyOn(axis, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 1000, 24));
  fireEvent.click(axis, { clientX: 650 });
  expect(onCursorChange).toHaveBeenLastCalledWith(5);
  fireEvent.click(axis, { clientX: 1100 });
  expect(onCursorChange).toHaveBeenLastCalledWith(9);
  fireEvent.keyDown(axis, { key: "ArrowLeft" });
  expect(onCursorChange).toHaveBeenLastCalledWith(3);
  view.rerender(<ExperimentCourse {...props} cursorWindow={7} windowMs={100} onCursorChange={onCursorChange} />);
  expect(screen.getByTestId("course-cursor").getAttribute("data-cursor-window")).toBe("7");
});

it("restores expansion and resized height while storage failures keep controls usable", () => {
  const view = render(<ExperimentCourse {...props} />);
  openCourse();
  const separator = screen.getByRole("separator", { name: "Resize experiment course" });
  fireEvent.keyDown(separator, { key: "ArrowUp" });
  const height = separator.getAttribute("aria-valuenow");
  view.unmount();
  render(<ExperimentCourse {...props} />);
  expect(screen.getByRole("button", { name: "Experiment course" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(height);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  openCourse();
  expect(screen.queryByRole("separator")).toBeNull();
});

it("ignores malformed browser preferences and unreadable storage", () => {
  localStorage.setItem("resilience-lab.experiment-course", '{"open":true,"height":"bad"}');
  const view = render(<ExperimentCourse {...props} />);
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  view.unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<ExperimentCourse {...props} />);
  openCourse();
  expect(screen.getByRole("button", { name: "Service dependency · Slowdown 6× · 200–700 ms" })).toBeTruthy();
});

it("reports the expanded overlay height so the canvas can fit above it", () => {
  const onHeightChange = vi.fn();
  render(<ExperimentCourse {...props} onHeightChange={onHeightChange} />);
  expect(onHeightChange).toHaveBeenLastCalledWith(0);
  openCourse();
  expect(onHeightChange).toHaveBeenLastCalledWith(220);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  expect(onHeightChange).toHaveBeenLastCalledWith(236);
  openCourse();
  expect(onHeightChange).toHaveBeenLastCalledWith(0);
});
