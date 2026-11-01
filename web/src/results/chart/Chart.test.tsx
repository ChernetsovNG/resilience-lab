import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { Chart } from "./Chart";
import { ChartCursorProvider } from "./ChartCursor";
import type { ChartDescription } from "./types";
import { TimelineChart } from "../timeline/TimelineChart";
import { timelineColor } from "./palette";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const description: ChartDescription = {
  title: "Queue", unit: "requests", colorBy: "element",
  x: { kind: "time", id: "time:run-1", domain: [0, 25], windowMs: 10, label: "Simulation time (ms)" },
  series: [{ id: "gateway", label: "Gateway", elementId: "gateway", color: "#123456", dash: "dashed", width: 3,
    marker: "circle", points: [{ x: 0, endX: 10, window: 0, value: 1 },
      { x: 10, endX: 20, window: 1, value: null }, { x: 20, endX: 25, window: 2, value: 90 }],
    range: [{ x: 0, endX: 10, window: 0, range: [0, 2] }, { x: 10, endX: 20, window: 1, range: null },
      { x: 20, endX: 25, window: 2, range: [80, 100] }] }],
  overlays: [{ kind: "region", id: "warmup", role: "warmup", from: 0, to: 10, label: "Warmup" },
    { kind: "threshold", id: "timeout", value: 110, label: "Timeout" },
    { kind: "marker", id: "sample", x: 5, value: 2, label: "Profile point" },
    { kind: "state", id: "breaker", label: "Breaker open", color: "#b91c1c",
      points: [{ x: 0, endX: 10, window: 0, value: 0.5, description: "Open half of window" }] }],
};

const colorIds = ["node-2", "node-68", "node-79", "node-3", "node-69", "node-78"];

it.each([2, 6])("gives %i automatic chart series distinct colors in paths and legends", count => {
  const series = colorIds.slice(0, count).map(id => ({ ...description.series[0], id, label: id, elementId: id, color: undefined }));
  const view = render(<Chart description={{ ...description, series, overlays: [] }} />);
  const strokes = () => [...view.container.querySelectorAll(".chart-line")].map(line => line.getAttribute("stroke"));
  const colors = strokes();
  expect(new Set(colors).size).toBe(count);
  expect(new Set([...view.container.querySelectorAll<HTMLElement>(".chart-line-key")].map(key => key.style.borderColor)).size).toBe(count);
  view.rerender(<Chart description={{ ...description, series: [...series].reverse(), overlays: [] }} />);
  expect(strokes()).toEqual([...colors].reverse());
});

it.each([2, 6])("gives %i Timeline series distinct colors despite colliding key preferences", count => {
  const lines = colorIds.slice(0, count).map(id => ({ id, label: id, elementId: id, variantId: "baseline", replication: 0,
    metric: "value", scale: 1, comparison: false, color: timelineColor(id, "value", false),
    windows: [{ startMs: 0, durationMs: 25, value: 1 }] }));
  const { container } = render(<TimelineChart title="Queue" unit="requests" lines={lines} regions={[]}
    endMs={25} windowMs={10} axisId="time:run-1" />);
  expect(new Set([...container.querySelectorAll(".chart-line")].map(line => line.getAttribute("stroke"))).size).toBe(count);
});

function Harness({ compact = false }: { compact?: boolean }) {
  const [hoverWindow, onHover] = useState<number | null>(null);
  const [cursorWindow, onCursor] = useState<number | null>(null);
  return <ChartCursorProvider axisId="time:run-1" hoverWindow={hoverWindow} cursorWindow={cursorWindow}
    onHover={onHover} onCursor={onCursor}>
    <Chart description={{ ...description, preset: compact ? "compact" : "full" }} />
    <Chart description={{ ...description, title: "Latency", overlays: [] }} />
    <Chart description={{ ...description, title: "Another run", x: { ...description.x, id: "time:run-2" }, overlays: [] }} />
  </ChartCursorProvider>;
}

it("renders step gaps, range gaps, thresholds, markers and state descriptions from data", () => {
  const { container } = render(<Chart description={description} />);
  const line = container.querySelector(".chart-line")!;
  expect(line.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  expect(line.getAttribute("stroke")).toBe("#123456");
  expect(line.getAttribute("stroke-dasharray")).toBe("6 4");
  expect(line.getAttribute("stroke-width")).toBe("3");
  expect(container.querySelector(".chart-range")?.getAttribute("d")?.match(/Z/g)).toHaveLength(2);
  expect(container.querySelectorAll(".chart-marker")).toHaveLength(3);
  expect(container.querySelectorAll(".chart-region")).toHaveLength(1);
  expect(Number(container.querySelector(".chart-threshold")?.getAttribute("y1"))).toBeGreaterThanOrEqual(12);
  expect(Number(container.querySelector(".chart-threshold")?.getAttribute("y1"))).toBeLessThan(144);
  expect(screen.getByText("Open half of window")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Queue" })).getByText("110 requests")).toBeTruthy();
});

it("shares hover and keyboard selection only across the same X axis and reads original null windows", () => {
  render(<Harness />);
  const queue = screen.getByRole("region", { name: "Queue" });
  const latency = screen.getByRole("region", { name: "Latency" });
  const other = screen.getByRole("region", { name: "Another run" });
  const slider = within(queue).getByRole("slider", { name: "Queue time cursor" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 100, width: 500 } as DOMRect);
  fireEvent.pointerMove(slider, { clientX: 300 });
  expect(queue.querySelector('[data-hover-window="1"]')).toBeTruthy();
  expect(latency.querySelector('[data-hover-window="1"]')).toBeTruthy();
  expect(other.querySelector("[data-hover-window]")).toBeNull();
  expect(within(queue.querySelector("dl")!).getByText("—")).toBeTruthy();
  fireEvent.click(slider, { clientX: 600 });
  expect(slider.getAttribute("aria-valuenow")).toBe("2");
  expect(latency.querySelector('[data-cursor-window="2"]')).toBeTruthy();
  expect(within(queue).getByText("90 requests")).toBeTruthy();
  fireEvent.keyDown(slider, { key: "Home" });
  expect(slider.getAttribute("aria-valuenow")).toBe("0");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(slider.getAttribute("aria-valuenow")).toBe("1");
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  expect(slider.getAttribute("aria-valuenow")).toBe("0");
  fireEvent.keyDown(slider, { key: "End" });
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(slider.getAttribute("aria-valuenow")).toBe("2");
});

it("keeps compact hover and selection while showing only endpoint labels and no legend", () => {
  render(<Harness compact />);
  const queue = screen.getByRole("region", { name: "Queue" });
  expect(queue.querySelector("dl")).toBeNull();
  expect(queue.querySelectorAll(".chart-x-tick")).toHaveLength(2);
  expect(queue.querySelectorAll(".chart-y-tick")).toHaveLength(2);
  const slider = within(queue).getByRole("slider", { name: "Queue time cursor" });
  fireEvent.keyDown(slider, { key: "End" });
  expect(queue.querySelector('[data-cursor-window="2"]')).toBeTruthy();
});

it("keeps plotted endpoints and state lanes aligned with the hit area after resizing", () => {
  let resize: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  const { container } = render(<Chart description={description} />);
  act(() => resize([{ contentRect: { width: 300 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(container.querySelector(".chart-plot svg")?.getAttribute("viewBox")).toBe("0 0 300 176");
  expect(container.querySelector(".chart-line")?.getAttribute("d")).toMatch(/H288$/);
  expect(container.querySelector(".chart-plot .chart-interaction rect")?.getAttribute("width")).toBe("232");
  expect(container.querySelector(".chart-state-band .chart-interaction rect")?.getAttribute("width")).toBe("232");
});
