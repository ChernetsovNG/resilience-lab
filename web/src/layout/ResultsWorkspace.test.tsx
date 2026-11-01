import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultsWorkspace } from "./ResultsWorkspace";
import type { ResultsPanelSize } from "./ResultsPanel";

let resizeWindow: (height: number) => void;
let resizeWorkspace: (width: number, height: number) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1440, 800));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeWindow = height => callback([{ contentRect: new DOMRect(0, 0, 1440, height) } as ResizeObserverEntry], this);
      resizeWorkspace = (width, height) => callback([{ contentRect: new DOMRect(0, 0, width, height) } as ResizeObserverEntry], this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const workspace = (analysis = false) => <ResultsWorkspace view="answer" size="normal" analysis={analysis}><section /></ResultsWorkspace>;
const height = () => Number(screen.getByRole("separator").getAttribute("aria-valuenow"));

it("shows the top of a newly selected element inspector", () => {
  const view = render(<ResultsWorkspace view="answer" size="normal" analysis={false} inspectorSelection="gateway"
    inspector={<aside>Gateway</aside>}><section /></ResultsWorkspace>);
  const content = document.querySelector<HTMLDivElement>(".inspector-content")!;
  content.scrollTop = 500;
  view.rerender(<ResultsWorkspace view="answer" size="normal" analysis={false} inspectorSelection="middle"
    inspector={<aside>Middle</aside>}><section /></ResultsWorkspace>);
  expect(content.scrollTop).toBe(0);
});

it.each([[408, 160, 240], [308, 150, 150]])("bounds both areas at workspace height %i and restores the desired height on growth", (size, min, max) => {
  render(workspace());
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(632);
  act(() => { resizeWindow(size); vi.advanceTimersToNextFrame(); });
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuemin"))).toBe(min);
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuemax"))).toBe(max);
  expect(height()).toBe(max);
  act(() => { resizeWindow(800); vi.advanceTimersToNextFrame(); });
  expect(height()).toBe(632);
});

it("keeps independent tab heights in ordinary and Analysis layouts", () => {
  const view = render(workspace());
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  const normal = height();
  view.rerender(workspace(true));
  expect(height()).toBeGreaterThan(normal);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  const analysis = height();
  view.rerender(workspace());
  expect(height()).toBe(normal);
  view.rerender(workspace(true));
  expect(height()).toBe(analysis);
});

it("keeps the initial Analysis diagram readable while permitting a manual 160px limit", () => {
  render(workspace(true));
  act(() => { resizeWindow(600); vi.advanceTimersToNextFrame(); });
  expect(height()).toBe(304);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(432);
});

it.each(["invalid", "null", "[]", '{"normal:answer":-40,"normal:timeline":"bad"}'])("ignores unusable persisted heights: %s", value => {
  localStorage.setItem("resilience-lab.results-panel-heights", value);
  render(workspace());
  expect(height()).toBeGreaterThan(160);
  expect(height()).toBeLessThan(632);
  const initial = height();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  expect(height()).toBe(initial + 16);
});

it("keeps resizing when browser storage cannot be read or written", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
  render(workspace());
  const initial = height();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  expect(height()).toBe(initial + 16);
});

const withInspector = (selected: string | null = null) => <ResultsWorkspace view="answer" size="normal" analysis={false}
  inspector={<input aria-label="Draft" defaultValue="draft" />} inspectorSelection={selected}><section /></ResultsWorkspace>;
const inspectorDivider = () => screen.getByRole("separator", { name: "Resize inspector" });
const inspectorWidth = () => Number(inspectorDivider().getAttribute("aria-valuenow"));

it("defers an observed workspace resize until the next frame", () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  render(withInspector());
  act(() => resizeWorkspace(900, 800));
  expect(inspectorWidth()).toBe(317);
  act(() => frame!(0));
  expect(inspectorWidth()).toBe(280);
});

it("does not commit another render for unchanged workspace dimensions", () => {
  vi.useFakeTimers();
  const committed = vi.fn();
  render(<Profiler id="workspace" onRender={committed}>{withInspector()}</Profiler>);
  committed.mockClear();
  act(() => { resizeWorkspace(1440, 800); vi.advanceTimersToNextFrame(); });
  expect(committed).not.toHaveBeenCalled();
});

it("resizes the inspector with arrows, clamps its bounds and resets on double-click", () => {
  render(withInspector());
  expect(inspectorWidth()).toBe(317);
  fireEvent.keyDown(inspectorDivider(), { key: "ArrowLeft" });
  expect(inspectorWidth()).toBe(333);
  fireEvent.keyDown(inspectorDivider(), { key: "Home" });
  fireEvent.keyDown(inspectorDivider(), { key: "ArrowRight" });
  expect(inspectorWidth()).toBe(280);
  fireEvent.keyDown(inspectorDivider(), { key: "End" });
  fireEvent.keyDown(inspectorDivider(), { key: "ArrowLeft" });
  expect(inspectorWidth()).toBe(720);
  fireEvent.doubleClick(inspectorDivider());
  expect(inspectorWidth()).toBe(317);
  act(() => { resizeWorkspace(1920, 800); vi.advanceTimersToNextFrame(); });
  expect(inspectorWidth()).toBe(422);
});

it("resizes the inspector by pointer and stops after pointer cancellation", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const divider = render(withInspector());
  Object.defineProperty(inspectorDivider(), "setPointerCapture", { value: vi.fn() });
  fireEvent.pointerDown(inspectorDivider(), { button: 0, clientX: 1000 });
  fireEvent.pointerMove(inspectorDivider(), { clientX: 900 });
  expect(inspectorWidth()).toBe(417);
  fireEvent.pointerMove(inspectorDivider(), { clientX: 0 });
  expect(inspectorWidth()).toBe(720);
  fireEvent.pointerCancel(inspectorDivider());
  fireEvent.pointerMove(inspectorDivider(), { clientX: 1100 });
  expect(inspectorWidth()).toBe(720);
  divider.unmount();
});

it("keeps the inspector within half of an odd workspace width", () => {
  render(withInspector());
  act(() => { resizeWorkspace(1441, 800); vi.advanceTimersToNextFrame(); });
  fireEvent.keyDown(inspectorDivider(), { key: "End" });
  expect(inspectorWidth()).toBeLessThanOrEqual(720.5);
});

it("persists inspector collapse and selection without losing a field draft", () => {
  const view = render(withInspector());
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "unfinished" } });
  fireEvent.click(screen.getByRole("button", { name: "Collapse inspector" }));
  view.rerender(withInspector("dependency"));
  expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
  expect(screen.getByRole("button", { name: "Expand inspector: dependency selected" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Expand inspector: dependency selected" }));
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("unfinished");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inspector" }));
  view.unmount();
  render(withInspector());
  expect(screen.getByRole("button", { name: "Expand inspector" })).toBeTruthy();
});

it("constrains a saved inspector width in a smaller window and restores it on growth", () => {
  const view = render(withInspector());
  fireEvent.keyDown(inspectorDivider(), { key: "End" });
  view.unmount();
  render(withInspector());
  expect(inspectorWidth()).toBe(720);
  act(() => { resizeWorkspace(900, 800); vi.advanceTimersToNextFrame(); });
  expect(inspectorWidth()).toBe(364);
  act(() => { resizeWorkspace(1440, 800); vi.advanceTimersToNextFrame(); });
  expect(inspectorWidth()).toBe(720);
});

function ExpandingWorkspace() {
  const [size, setSize] = useState<ResultsPanelSize>("normal");
  return <ResultsWorkspace view="answer" size={size} onSizeChange={setSize} analysis={false} inspectorSelection="dependency">
    <section />
  </ResultsWorkspace>;
}

it("snaps past the 160px diagram limit and restores the previous height on double-click", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  render(<ExpandingWorkspace />);
  const divider = screen.getByRole("separator");
  const initial = height();
  Object.defineProperty(divider, "setPointerCapture", { value: vi.fn() });
  fireEvent.pointerDown(divider, { button: 0, clientY: 400 });
  fireEvent.pointerMove(divider, { clientY: -400 });
  fireEvent.pointerCancel(divider);
  expect(document.querySelector(".workspace-panels--expanded")).not.toBeNull();
  expect(screen.getByText("Diagram collapsed")).toBeTruthy();
  fireEvent.doubleClick(divider);
  expect(document.querySelector(".workspace-panels--expanded")).toBeNull();
  expect(height()).toBe(initial);
});

it("supports keyboard snapping without expanding in a cramped window", () => {
  render(<ExpandingWorkspace />);
  const divider = screen.getByRole("separator");
  fireEvent.keyDown(divider, { key: "End" });
  expect(height()).toBe(632);
  fireEvent.keyDown(divider, { key: "ArrowUp" });
  expect(document.querySelector(".workspace-panels--expanded")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show diagram" }));
  expect(height()).toBe(632);
  act(() => { resizeWindow(308); vi.advanceTimersToNextFrame(); });
  fireEvent.keyDown(divider, { key: "ArrowUp" });
  expect(document.querySelector(".workspace-panels--expanded")).toBeNull();
  expect(height()).toBe(150);
});

it("stays snapped when a drag continues just beyond the normal limit", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  render(<ExpandingWorkspace />);
  const divider = screen.getByRole("separator");
  const initial = height();
  Object.defineProperty(divider, "setPointerCapture", { value: vi.fn() });
  fireEvent.pointerDown(divider, { button: 0, clientY: 400 });
  fireEvent.pointerMove(divider, { clientY: 20 });
  expect(document.querySelector(".workspace-panels--expanded")).not.toBeNull();
  fireEvent.pointerMove(divider, { clientY: 19 });
  expect(document.querySelector(".workspace-panels--expanded")).not.toBeNull();
  fireEvent.pointerCancel(divider);
  fireEvent.doubleClick(divider);
  expect(height()).toBe(initial);
});

it("keeps the canvas mounted, shows selection in the strip and can reveal it explicitly", () => {
  const onSizeChange = vi.fn(), onShowSelection = vi.fn();
  const panel = (size: ResultsPanelSize) => <ResultsWorkspace view="answer" size={size} onSizeChange={onSizeChange}
    onShowSelection={onShowSelection} analysis={false} inspectorSelection="dependency">
    <main className="canvas-area"><input aria-label="Canvas draft" defaultValue="unfinished" /></main>
  </ResultsWorkspace>;
  const view = render(panel("normal"));
  const draft = screen.getByLabelText("Canvas draft");
  view.rerender(panel("expanded"));
  expect(screen.getByText("Selected: dependency")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show on diagram" }));
  expect(onSizeChange).toHaveBeenCalledWith("normal");
  expect(onShowSelection).toHaveBeenCalledOnce();
  view.rerender(panel("normal"));
  expect(screen.getByLabelText("Canvas draft")).toBe(draft);
});

it("shrinks expanded results with the keyboard", () => {
  render(<ExpandingWorkspace />);
  const divider = screen.getByRole("separator");
  fireEvent.doubleClick(divider);
  fireEvent.keyDown(divider, { key: "ArrowDown" });
  expect(document.querySelector(".workspace-panels--expanded")).toBeNull();
  expect(height()).toBe(632);
});

it("restores a bounded previous height after the expanded window shrinks and grows", () => {
  render(<ExpandingWorkspace />);
  const divider = screen.getByRole("separator");
  fireEvent.keyDown(divider, { key: "ArrowUp" });
  const initial = height();
  fireEvent.doubleClick(divider);
  act(() => { resizeWindow(308); vi.advanceTimersToNextFrame(); });
  fireEvent.click(screen.getByRole("button", { name: "Show diagram" }));
  expect(height()).toBe(150);
  act(() => { resizeWindow(800); vi.advanceTimersToNextFrame(); });
  expect(height()).toBe(initial);
});

it("opens Analysis at the selected element's results after scrolling through parameters", () => {
  const panel = (analysis: boolean) => <ResultsWorkspace view="answer" size="normal" analysis={analysis}
    inspector={<section>Selected output</section>} inspectorSelection="gateway"><section /></ResultsWorkspace>;
  const view = render(panel(false));
  const content = document.querySelector<HTMLElement>(".inspector-content")!;
  content.scrollTop = 500;
  view.rerender(panel(true));
  expect(content.scrollTop).toBe(0);
});

it("reveals a collapsed inspector when a course fault requests its fields", () => {
  const view = render(<ResultsWorkspace view="answer" size="collapsed" analysis={false} inspector={<aside>Fault fields</aside>} inspectorRequest={0}><section /></ResultsWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Collapse inspector" }));
  view.rerender(<ResultsWorkspace view="answer" size="collapsed" analysis={false} inspector={<aside>Fault fields</aside>} inspectorRequest={1}><section /></ResultsWorkspace>);
  expect(screen.getByText("Fault fields").closest("[hidden]")).toBeNull();
});

it("reserves the course footer in the minimum canvas allocation", () => {
  render(<ResultsWorkspace view="timeline" size="normal" analysis={false} canvasFooterHeight={32}><section /></ResultsWorkspace>);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(600);
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuemax"))).toBe(600);
});

it("reserves canvas messages and tabs in addition to the usable diagram height", () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 1440, this.classList.contains("canvas-messages") ? 40 : this.tagName === "NAV" ? 36 : 800);
  });
  render(<ResultsWorkspace view="answer" size="normal" analysis canvasFooterHeight={32}>
    <main className="canvas-area"><div className="canvas-messages" /><div className="canvas" /><nav /></main>
  </ResultsWorkspace>);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(524);
});

it("keeps a readable plot when wrapped controls consume a cramped workspace", () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 960, this.classList.contains("canvas-messages") ? 180 : this.tagName === "NAV" ? 36 : 400);
  });
  render(<ResultsWorkspace view="timeline" size="normal" analysis={false} canvasFooterHeight={32}>
    <main className="canvas-area"><div className="canvas-messages" /><div className="canvas" /><nav /></main>
  </ResultsWorkspace>);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  // 400px minus divider, controls, tabs, footer, and an 80px usable plotting area.
  expect(height()).toBe(64);
});
