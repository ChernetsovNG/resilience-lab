import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineGrid } from "./TimelineGrid";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("uses one to three columns from its own width, independently of the window", () => {
  let resize: (width: number) => void = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resize = width => callback([{ contentRect: new DOMRect(0, 0, width, 400) } as ResizeObserverEntry], this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 400));
  const view = render(<TimelineGrid><article /><article /><article /><article /></TimelineGrid>);
  const grid = view.container.firstElementChild as HTMLElement;
  for (const [width, columns] of [[700, 1], [1000, 2], [1600, 3], [3840, 3], [700, 1]]) {
    act(() => resize(width));
    expect(grid.style.gridTemplateColumns).toBe(`repeat(${columns}, minmax(0, 1fr))`);
  }
});
