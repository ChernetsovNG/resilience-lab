import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultsWorkspace } from "./ResultsWorkspace";

let resizeWindow: (height: number) => void;
let resizeWorkspace: (width: number, height: number) => void;

beforeEach(() => {
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const workspace = (analysis = false) => <ResultsWorkspace view="answer" collapsed={false} analysis={analysis}><section /></ResultsWorkspace>;
const height = () => Number(screen.getByRole("separator").getAttribute("aria-valuenow"));

it("shows the top of a newly selected element inspector", () => {
  const view = render(<ResultsWorkspace view="answer" collapsed={false} analysis={false} inspectorSelection="gateway"
    inspector={<aside>Gateway</aside>}><section /></ResultsWorkspace>);
  const content = document.querySelector<HTMLDivElement>(".inspector-content")!;
  content.scrollTop = 500;
  view.rerender(<ResultsWorkspace view="answer" collapsed={false} analysis={false} inspectorSelection="middle"
    inspector={<aside>Middle</aside>}><section /></ResultsWorkspace>);
  expect(content.scrollTop).toBe(0);
});

it.each([[408, 160, 180], [308, 150, 150]])("bounds both areas at workspace height %i and restores the desired height on growth", (size, min, max) => {
  render(workspace());
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(572);
  act(() => resizeWindow(size));
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuemin"))).toBe(min);
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuemax"))).toBe(max);
  expect(height()).toBe(max);
  act(() => resizeWindow(800));
  expect(height()).toBe(572);
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

it.each(["invalid", "null", "[]", '{"normal:answer":-40,"normal:timeline":"bad"}'])("ignores unusable persisted heights: %s", value => {
  localStorage.setItem("resilience-lab.results-panel-heights", value);
  render(workspace());
  expect(height()).toBeGreaterThan(160);
  expect(height()).toBeLessThan(572);
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

const withInspector = (selected: string | null = null) => <ResultsWorkspace view="answer" collapsed={false} analysis={false}
  inspector={<input aria-label="Draft" defaultValue="draft" />} inspectorSelection={selected}><section /></ResultsWorkspace>;
const inspectorDivider = () => screen.getByRole("separator", { name: "Resize inspector" });
const inspectorWidth = () => Number(inspectorDivider().getAttribute("aria-valuenow"));

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
  expect(inspectorWidth()).toBe(480);
  fireEvent.doubleClick(inspectorDivider());
  expect(inspectorWidth()).toBe(317);
  act(() => resizeWorkspace(1920, 800));
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
  expect(inspectorWidth()).toBe(480);
  fireEvent.pointerCancel(inspectorDivider());
  fireEvent.pointerMove(inspectorDivider(), { clientX: 1100 });
  expect(inspectorWidth()).toBe(480);
  divider.unmount();
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
  expect(inspectorWidth()).toBe(480);
  act(() => resizeWorkspace(900, 800));
  expect(inspectorWidth()).toBe(364);
  act(() => resizeWorkspace(1440, 800));
  expect(inspectorWidth()).toBe(480);
});

it("resets only the current results height to its relative default", () => {
  const view = render(workspace());
  const divider = () => screen.getByRole("separator", { name: "Resize results panel" });
  fireEvent.keyDown(divider(), { key: "End" });
  view.rerender(workspace(true));
  fireEvent.keyDown(divider(), { key: "Home" });
  fireEvent.doubleClick(divider());
  expect(height()).toBe(491);
  view.rerender(workspace());
  expect(height()).toBe(572);
});


it("opens Analysis at the selected element's results after scrolling through parameters", () => {
  const panel = (analysis: boolean) => <ResultsWorkspace view="answer" collapsed={false} analysis={analysis}
    inspector={<section>Selected output</section>} inspectorSelection="gateway"><section /></ResultsWorkspace>;
  const view = render(panel(false));
  const content = document.querySelector<HTMLElement>(".inspector-content")!;
  content.scrollTop = 500;
  view.rerender(panel(true));
  expect(content.scrollTop).toBe(0);
});

it("reveals a collapsed inspector when a course fault requests its fields", () => {
  const view = render(<ResultsWorkspace view="answer" collapsed analysis={false} inspector={<aside>Fault fields</aside>} inspectorRequest={0}><section /></ResultsWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Collapse inspector" }));
  view.rerender(<ResultsWorkspace view="answer" collapsed analysis={false} inspector={<aside>Fault fields</aside>} inspectorRequest={1}><section /></ResultsWorkspace>);
  expect(screen.getByText("Fault fields").closest("[hidden]")).toBeNull();
});

it("reserves the course footer in the minimum canvas allocation", () => {
  render(<ResultsWorkspace view="timeline" collapsed={false} analysis={false} canvasFooterHeight={32}><section /></ResultsWorkspace>);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(540);
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuemax"))).toBe(540);
});

it("reserves canvas messages and tabs in addition to the usable diagram height", () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 1440, this.classList.contains("canvas-messages") ? 40 : this.tagName === "NAV" ? 36 : 800);
  });
  render(<ResultsWorkspace view="answer" collapsed={false} analysis canvasFooterHeight={32}>
    <main className="canvas-area"><div className="canvas-messages" /><div className="canvas" /><nav /></main>
  </ResultsWorkspace>);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(height()).toBe(396);
});

it("keeps a readable plot when wrapped controls consume a cramped workspace", () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 960, this.classList.contains("canvas-messages") ? 180 : this.tagName === "NAV" ? 36 : 400);
  });
  render(<ResultsWorkspace view="timeline" collapsed={false} analysis={false} canvasFooterHeight={32}>
    <main className="canvas-area"><div className="canvas-messages" /><div className="canvas" /><nav /></main>
  </ResultsWorkspace>);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  // 400px minus divider, controls, tabs, footer, and an 80px usable plotting area.
  expect(height()).toBe(64);
});
