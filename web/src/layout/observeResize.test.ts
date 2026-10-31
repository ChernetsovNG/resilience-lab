import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeResize } from "./observeResize";

let notify: (width: number) => void;
const element = document.createElement("div");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      notify = width => callback([{ target: element, contentRect: new DOMRect(0, 0, width, 80),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("delivers only the latest measurement in the next frame", () => {
  const widths: number[] = [];
  const disconnect = observeResize([element], ([entry]) => widths.push(entry.contentRect.width));
  notify(100);
  notify(200);
  expect(widths).toEqual([]);
  vi.advanceTimersToNextFrame();
  expect(widths).toEqual([200]);
  notify(300);
  vi.advanceTimersToNextFrame();
  expect(widths).toEqual([200, 300]);
  disconnect();
});

it("cancels pending measurements on cleanup, including StrictMode remounts", () => {
  const widths: number[] = [];
  const disconnect = observeResize([element], ([entry]) => widths.push(entry.contentRect.width));
  notify(100);
  disconnect();
  const disconnectAgain = observeResize([element], ([entry]) => widths.push(entry.contentRect.width));
  notify(200);
  vi.advanceTimersToNextFrame();
  expect(widths).toEqual([200]);
  disconnectAgain();
});
