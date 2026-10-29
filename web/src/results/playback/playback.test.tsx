import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { windowCanvasResults, type CanvasResults } from "../canvasResults";
import type { NodeSeriesMetrics, SeriesLoadRequest, WindowMetricValues } from "../series";
import { usePlayback } from "./usePlayback";

const summary: CanvasResults = {
  services: new Map([["dependency", { utilization: 0.5, meanQueue: 0.1, queueRejectionRate: 0.02, firstSaturation: "1 of 2 replications" }]]),
  connections: new Map([["call", { from: "gateway", to: "dependency", type: "call", amplification: 1.2 }]]),
};

function metric(index: number, meanQueueLength: number, amplification: number | null): WindowMetricValues {
  return {
    startMs: index * 100, durationMs: index === 5 ? 50 : 100,
    originalArrivalsPerSecond: 0, offeredAttemptsPerSecond: 200, admittedAttemptsPerSecond: 150,
    queueRejectionsPerSecond: 50, successesPerSecond: 0, failuresPerSecond: 0, timeoutsPerSecond: 0,
    retriesPerSecond: 0, handlerUtilization: 0.8, meanQueueLength, meanLatencyMs: null,
    p50LatencyMs: null, p95LatencyMs: null, p99LatencyMs: null, amplification,
  };
}
const series: NodeSeriesMetrics[] = [
  { id: "dependency", windows: [metric(0, 0, 1), metric(1, 1, 1.5), metric(2, 3, 2), metric(3, 9, 3), metric(4, 4, 2), metric(5, 1, 1)] },
  { id: "new-service", windows: [metric(0, 99, 99)] },
];
const loaded = { load: async () => series };

afterEach(() => vi.useRealTimers());

describe("windowCanvasResults", () => {
  it("derives the same frame after skips, reverse seeks and replay, using the called service's window", () => {
    const frame = windowCanvasResults(summary, series, 3)!;
    expect(frame.services.get("dependency")).toMatchObject({ utilization: 0.8, meanQueue: 9, queueRejectionRate: 0.25 });
    expect(frame.connections.get("call")?.amplification).toBe(3);
    expect(frame.services.has("new-service")).toBe(false);
    windowCanvasResults(summary, series, 5);
    windowCanvasResults(summary, series, 0);
    expect(windowCanvasResults(summary, series, 3)).toEqual(frame);
    expect(summary.services.get("dependency")?.meanQueue).toBe(0.1);
    expect(summary.connections.get("call")?.amplification).toBe(1.2);
  });

  it("waits for every displayed service and preserves unavailable values instead of borrowing the summary", () => {
    expect(windowCanvasResults(summary, [], 0)).toBeNull();
    expect(windowCanvasResults(summary, series, 6)).toBeNull();
    expect(windowCanvasResults(summary, series, -1)).toBeNull();
    const zero = metric(0, 0, null);
    zero.offeredAttemptsPerSecond = 0;
    zero.handlerUtilization = null;
    const frame = windowCanvasResults(summary, [{ id: "dependency", windows: [zero] }], 0)!;
    expect(frame.services.get("dependency")).toMatchObject({ utilization: null, meanQueue: 0, queueRejectionRate: null });
    expect(frame.connections.get("call")?.amplification).toBeNull();
  });
});

interface Context { variant: string | null; pointId: string; replication: number }
function setup(loader: { load: (request: SeriesLoadRequest) => Promise<NodeSeriesMetrics[]> } = loaded, windowCount = 6, nodes = ["dependency"]) {
  return renderHook(({ variant, pointId, replication }: Context) => {
    const [window, onWindowChange] = useState<number | null>(null);
    return { window, ...usePlayback({
      runId: "run-1", variant, pointId, replication, window, windowCount,
      nodes, results: summary, onWindowChange,
    }, loader) };
  }, { initialProps: { variant: "baseline", pointId: "p0", replication: 0 } as Context });
}

it("waits for loading, advances the shared cursor, and freezes the frame on pause", async () => {
  vi.useFakeTimers();
  let resolve!: (nodes: NodeSeriesMetrics[]) => void;
  const loader = { load: () => new Promise<NodeSeriesMetrics[]>((done) => { resolve = done; }) };
  const { result } = setup(loader);
  expect(result.current.window).toBeNull();
  await act(async () => result.current.play());
  expect(result.current.loading).toBe(true);
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.window).toBe(0);
  await act(async () => resolve(series));
  expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(0);
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(1);
  act(() => result.current.pause());
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.window).toBe(1);
  expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(1);
});

it("seeks deterministically, skips at higher speeds, stops at the final window and clears to summary", async () => {
  vi.useFakeTimers();
  const { result } = setup();
  await act(async () => result.current.seek(3));
  expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(9);
  await act(async () => result.current.seek(0));
  act(() => { result.current.setSpeed(4); result.current.play(); });
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(4);
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(5);
  expect(result.current.playing).toBe(false);
  expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(1);
  await act(async () => result.current.play());
  expect(result.current.window).toBe(0);
  act(() => result.current.seek(3));
  expect(result.current.playing).toBe(false);
  expect(result.current.frame?.connections.get("call")?.amplification).toBe(3);
  act(() => result.current.seek(null));
  expect(result.current.window).toBeNull();
  expect(result.current.frame).toBeNull();
});

it("stops on context changes and ignores obsolete replies", async () => {
  vi.useFakeTimers();
  const pending: { request: SeriesLoadRequest; resolve: (nodes: NodeSeriesMetrics[]) => void }[] = [];
  const loader = { load: (request: SeriesLoadRequest) => new Promise<NodeSeriesMetrics[]>((resolve) => pending.push({ request, resolve })) };
  const { result, rerender } = setup(loader);
  await act(async () => result.current.play());
  rerender({ variant: "no-retries", pointId: "p1", replication: 1 });
  expect(result.current.playing).toBe(false);
  expect(pending[0].request.signal?.aborted).toBe(true);
  await act(async () => pending[0].resolve(series));
  expect(result.current.frame).toBeNull();
  expect(pending[1].request).toMatchObject({ variant: "no-retries", cell: "p1", replication: 1 });
  await act(async () => pending[1].resolve(series));
  expect(result.current.frame?.connections.get("call")?.amplification).toBe(1);
  rerender({ variant: null, pointId: "p1", replication: 1 });
  expect(result.current.frame).toBeNull();
  expect(result.current.playing).toBe(false);
});

it("reports failed series without advancing a phantom frame", async () => {
  vi.useFakeTimers();
  const { result } = setup({ load: async () => { throw new Error("Series unavailable"); } });
  await act(async () => result.current.play());
  expect(result.current.problem).toBe("Series unavailable");
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.window).toBe(0);
  expect(result.current.frame).toBeNull();
});

it("preserves absolute window numbers when only a later range is loaded", () => {
  const frame = windowCanvasResults(summary, [{ id: "dependency", windows: [metric(67, 9, 3)] }], 67, 67)!;
  expect(frame?.services.get("dependency")?.meanQueue).toBe(9);
  expect(frame.connections.get("call")?.amplification).toBe(3);
});

function range(request: SeriesLoadRequest): NodeSeriesMetrics[] {
  return [{ id: "dependency", windows: Array.from(
    { length: Math.min(32, request.untilWindow - request.fromWindow) },
    (_, offset) => metric(request.fromWindow + offset, request.fromWindow + offset, 2),
  ) }];
}

it.each([{ nodes: ["dependency"], until: 32 }, { nodes: Array.from({ length: 5000 }, (_, index) => `node-${index}`), until: 1 }])(
  "loads a bounded working range for $nodes.length nodes rather than the whole recording",
  async ({ nodes, until }) => {
    const requests: SeriesLoadRequest[] = [];
    const loader = { load: async (request: SeriesLoadRequest) => { requests.push(request); return range(request); } };
    const { result } = setup(loader, 100_000, nodes);
    await act(async () => result.current.play());
    expect(requests[0]).toMatchObject({ fromWindow: 0, untilWindow: until });
    expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(0);
    await act(async () => result.current.seek(67));
    expect(requests[1].fromWindow).toBeGreaterThan(0);
    expect(requests[1].untilWindow - requests[1].fromWindow).toBe(until);
    expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(67);
  },
);

it("waits at a range boundary and resumes from the selected absolute window after loading", async () => {
  vi.useFakeTimers();
  const pending: { request: SeriesLoadRequest; resolve: (nodes: NodeSeriesMetrics[]) => void }[] = [];
  const loader = { load: (request: SeriesLoadRequest) => new Promise<NodeSeriesMetrics[]>((resolve) => pending.push({ request, resolve })) };
  const { result } = setup(loader, 100_000);
  await act(async () => result.current.seek(31));
  await act(async () => pending[0].resolve(range(pending[0].request)));
  act(() => result.current.play());
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(32);
  expect(result.current.loading).toBe(true);
  expect(pending[1].request).toMatchObject({ fromWindow: 32, untilWindow: 64 });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.window).toBe(32);
  await act(async () => pending[1].resolve(range(pending[1].request)));
  expect(result.current.frame?.services.get("dependency")?.meanQueue).toBe(32);
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(33);
});

it.each([10, 36_000])("paces playback in windows per second for %d ms windows", async (windowMs) => {
  vi.useFakeTimers();
  const timed = { load: async () => series.map((node) => ({ ...node, windows: node.windows.map((window, index) => ({
    ...window, startMs: index * windowMs, durationMs: windowMs,
  })) })) };
  const { result } = setup(timed);
  await act(async () => result.current.play());
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(1);
  act(() => result.current.setSpeed(0.25));
  act(() => vi.advanceTimersByTime(400));
  expect(result.current.window).toBe(2);
  act(() => result.current.setSpeed(4));
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(5);
  expect(result.current.playing).toBe(false);
});
