import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultsWorkspace } from "./ResultsWorkspace";

let resizeWindow: (height: number) => void;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1440, 800));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeWindow = height => callback([{ contentRect: new DOMRect(0, 0, 1440, height) } as ResizeObserverEntry], this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const workspace = (analysis = false) => <ResultsWorkspace view="answer" collapsed={false} analysis={analysis}><section /></ResultsWorkspace>;
const height = () => Number(screen.getByRole("separator").getAttribute("aria-valuenow"));

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
