import { catalog } from "../../test/fixtures";
import { recordedWindow } from "../../test/series";
import { outputsOf } from "../outputs";
import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { windowCanvasResults, type CanvasResults } from "../canvasResults";
import type { ConnectionSeriesLoadRequest, DecodedConnection, NodeSeriesMetrics, SeriesLoadRequest, WindowMetricValues } from "../series";
import { usePlayback } from "./usePlayback";

const summary: CanvasResults = {
  services: new Map([["dependency", { values: { utilization: 0.5, meanQueue: 0.1, queueRejectionRate: 0.02 },
    outputs: outputsOf(catalog, "service").filter(output => output.overlay != null), params: { queue: 16 }, firstSaturation: "1 of 2 replications" }]]),
  connections: new Map([["call", { from: "gateway", to: "dependency", type: "call", values: { amplification: 1.2 },
    outputs: outputsOf(catalog, "call").filter(output => output.overlay != null), params: {}, hasOwnSeries: false }]]),
};

function metric(index: number, meanQueueLength: number, amplification: number | null): WindowMetricValues {
  const durationMs = index === 5 ? 50 : 100;
  return recordedWindow({ startMs: index * 100,
      durationMs,
      offeredAttempts: durationMs / 5,
      admittedAttempts: durationMs * 0.15,
      entries: { total: { originalArrivals: amplification == null ? 0 : durationMs * 0.15 / amplification } },
      slotPools: { handlers: { busyIntegralMs: durationMs * 0.8, queueIntegralMs: meanQueueLength * durationMs, capacityIntegralMs: durationMs, waitCount: 0, totalWaitMs: 0, queueFullCount: durationMs / 20, waitLimitCount: 0 } } });
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
    expect(frame.services.get("dependency")?.values).toMatchObject({ utilization: 0.8, meanQueue: 9, queueRejectionRate: 0.25 });
    expect(frame.connections.get("call")?.values.amplification).toBe(3);
    expect(frame.services.has("new-service")).toBe(false);
    windowCanvasResults(summary, series, 5);
    windowCanvasResults(summary, series, 0);
    expect(windowCanvasResults(summary, series, 3)).toEqual(frame);
    expect(summary.services.get("dependency")?.values.meanQueue).toBe(0.1);
    expect(summary.connections.get("call")?.values.amplification).toBe(1.2);
  });

  it("waits for every displayed service and preserves unavailable values instead of borrowing the summary", () => {
    expect(windowCanvasResults(summary, [], 0)).toBeNull();
    expect(windowCanvasResults(summary, series, 6)).toBeNull();
    expect(windowCanvasResults(summary, series, -1)).toBeNull();
    const zero = metric(0, 0, null);
    zero.offeredAttempts = 0;
    zero.slotPools.handlers.capacityIntegralMs = 0;
    const frame = windowCanvasResults(summary, [{ id: "dependency", windows: [zero] }], 0)!;
    expect(frame.services.get("dependency")?.values).toMatchObject({ utilization: null, meanQueue: 0, queueRejectionRate: null });
    expect(frame.connections.get("call")?.values.amplification).toBeNull();
  });
});

interface Context { variant: string | null; pointId: string; replication: number }
function setup(loader: { load: (request: SeriesLoadRequest) => Promise<NodeSeriesMetrics[]> } = loaded, windowCount = 6, nodes = ["dependency"], results = summary) {
  return renderHook(({ variant, pointId, replication }: Context) => {
    const [window, onWindowChange] = useState<number | null>(null);
    return { window, ...usePlayback({
      runId: "run-1", variant, pointId, replication, window, windowCount,
      nodes, results, onWindowChange,
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
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(0);
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(1);
  act(() => result.current.pause());
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.window).toBe(1);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(1);
});

it("seeks deterministically, skips at higher speeds, stops at the final window and clears to summary", async () => {
  vi.useFakeTimers();
  const { result } = setup();
  await act(async () => result.current.seek(3));
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(9);
  await act(async () => result.current.seek(0));
  act(() => { result.current.setSpeed(4); result.current.play(); });
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(4);
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(5);
  expect(result.current.playing).toBe(false);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(1);
  await act(async () => result.current.play());
  expect(result.current.window).toBe(0);
  act(() => result.current.seek(3));
  expect(result.current.playing).toBe(false);
  expect(result.current.frame?.connections.get("call")?.values.amplification).toBe(3);
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
  expect(result.current.frame?.window).toBeUndefined();
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBeNull();
  expect(pending[1].request).toMatchObject({ variant: "no-retries", cell: "p1", replication: 1 });
  await act(async () => pending[1].resolve(series));
  expect(result.current.frame?.connections.get("call")?.values.amplification).toBe(1);
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
  expect(result.current.frame?.window).toBeUndefined();
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBeNull();
});

it("preserves absolute window numbers when only a later range is loaded", () => {
  const frame = windowCanvasResults(summary, [{ id: "dependency", windows: [metric(67, 9, 3)] }], 67, 67)!;
  expect(frame?.services.get("dependency")?.values.meanQueue).toBe(9);
  expect(frame.connections.get("call")?.values.amplification).toBe(3);
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
    expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(0);
    await act(async () => result.current.seek(67));
    expect(requests[1].fromWindow).toBeGreaterThan(0);
    expect(requests[1].untilWindow - requests[1].fromWindow).toBe(until);
    expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(67);
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
  expect(result.current.frame?.window).toBe(31);
  expect(result.current.frame?.pending).toMatch(/Loading/);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(31);
  expect(pending[1].request).toMatchObject({ fromWindow: 32, untilWindow: 64 });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.window).toBe(32);
  const current = pending.find(item => item.request.fromWindow === 32 && !item.request.signal?.aborted)!;
  await act(async () => current.resolve(range(current.request)));
  expect(result.current.frame?.pending).toBeUndefined();
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(32);
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


it("uses the connection's own windows while playing a frame", async () => {
  const ownSummary: CanvasResults = { ...summary, connections: new Map([["call", {
    ...summary.connections.get("call")!, hasOwnSeries: true, values: { amplification: 1.2, sentAttemptsPerSecond: 999, timeoutRate: 0.8, meanOrphaned: 5 },
  }]]) };
  const loader = { load: async () => series, loadConnections: async () => [{ id: "call", windows: [{
    failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs: 0,
      durationMs: 100,
      sentAttempts: 4,
      retries: 1,
      timeouts: 1,
      succeeded: 1,
      failed: 0,
      orphaned: 1,
      inFlightIntegralMs: 20,
      orphanedIntegralMs: 50,
      backoffIntegralMs: 10,
      latency: { count: 1, sumMs: 12, meanMs: 12, p50Ms: 12, p95Ms: 12, p99Ms: 12 },
      slotPools: {  } }] }] };
  const hook = renderHook(() => usePlayback({ runId: "run-1", variant: "baseline", pointId: "p0", replication: 0,
    window: 0, windowCount: 1, nodes: ["dependency"], results: ownSummary, onWindowChange: vi.fn(),
  }, loader));
  await waitFor(() => expect(hook.result.current.frame?.connections.get("call")?.values).toMatchObject({
    sentAttemptsPerSecond: 40, timeoutRate: 0.25, meanOrphaned: 0.5,
  }));
});


it("reserves empty metrics before the first recorded window arrives", async () => {
  const { result } = setup({ load: () => new Promise(() => {}) });
  await act(async () => result.current.seek(0));
  expect(result.current.frame?.window).toBeUndefined();
  expect(result.current.frame?.pending).toMatch(/Loading/);
  expect(result.current.frame?.services.get("dependency")?.values).toMatchObject({
    utilization: null, meanQueue: null, queueRejectionRate: null,
  });
  expect(result.current.frame?.connections.get("call")?.values.amplification).toBeNull();
});

it.each([
  { runId: "run-2" }, { variant: "no-retries" }, { pointId: "p1" }, { replication: 1 },
])("does not retain values across playback context changes: %j", async (change) => {
  let first = true;
  const loader = { load: async (request: SeriesLoadRequest) => {
    if (first) { first = false; return range(request); }
    return new Promise<NodeSeriesMetrics[]>(() => {});
  } };
  const initialProps = { runId: "run-1", variant: "baseline", pointId: "p0", replication: 0 };
  const { result, rerender } = renderHook(props => usePlayback({ ...props, window: 5, windowCount: 100,
    nodes: ["dependency"], results: summary, onWindowChange: vi.fn(),
  }, loader), { initialProps });
  await waitFor(() => expect(result.current.frame?.window).toBe(5));
  rerender({ ...initialProps, ...change });
  expect(result.current.frame?.window).toBeUndefined();
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBeNull();
  expect(result.current.frame?.connections.get("call")?.values.amplification).toBeNull();
});

it("prefetches the next node and connection ranges before the cursor reaches their boundary", async () => {
  const requests: SeriesLoadRequest[] = [];
  const connectionRequests: ConnectionSeriesLoadRequest[] = [];
  const ownSummary = { ...summary, connections: new Map([["call", {
    ...summary.connections.get("call")!, hasOwnSeries: true, values: { amplification: 1.2, sentAttemptsPerSecond: 999 },
  }]]) };
  const loader = {
    load: async (request: SeriesLoadRequest) => { requests.push(request); return range(request); },
    loadConnections: async (request: ConnectionSeriesLoadRequest) => {
      connectionRequests.push(request);
      return [{ id: "call", windows: Array.from({ length: request.untilWindow - request.fromWindow }, () => ({
        failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs: 0,
      durationMs: 100,
      sentAttempts: 4,
      retries: 1,
      timeouts: 1,
      succeeded: 1,
      failed: 0,
      orphaned: 1,
      inFlightIntegralMs: 20,
      orphanedIntegralMs: 50,
      backoffIntegralMs: 10,
      latency: { count: 1, sumMs: 12, meanMs: 12, p50Ms: 12, p95Ms: 12, p99Ms: 12 },
      slotPools: {  } })) }];
    },
  };
  const { result, rerender } = renderHook(({ window }) => usePlayback({
    runId: "run-1", variant: "baseline", pointId: "p0", replication: 0, window, windowCount: 70,
    nodes: ["dependency"], results: ownSummary, onWindowChange: vi.fn(),
  }, loader), { initialProps: { window: 0 } });
  await waitFor(() => expect(result.current.frame?.window).toBe(0));
  expect(requests.map(request => request.fromWindow)).toEqual([0, 32]);
  rerender({ window: 24 });
  await waitFor(() => expect(requests.some(request => request.fromWindow === 32 && request.untilWindow === 64)).toBe(true));
  expect(connectionRequests.some(request => request.fromWindow === 32 && request.untilWindow === 64)).toBe(true);
  expect(result.current.frame?.window).toBe(24);
  expect(result.current.frame?.pending).toBeUndefined();
  rerender({ window: 62 });
  await waitFor(() => expect(requests.some(request => request.fromWindow === 64 && request.untilWindow === 70)).toBe(true));
});

it("retries a failed prefetch in the foreground without interrupting the current frame", async () => {
  let fail = true;
  const loader = { load: async (request: SeriesLoadRequest) => {
    if (request.fromWindow === 32 && fail) { fail = false; throw new Error("Prefetch unavailable"); }
    return range(request);
  } };
  const { result } = setup(loader, 100);
  await act(async () => result.current.seek(24));
  expect(result.current.frame?.window).toBe(24);
  expect(result.current.problem).toBeNull();
  await act(async () => result.current.seek(32));
  expect(result.current.frame?.window).toBe(32);
  expect(result.current.problem).toBeNull();
});

it("starts node and connection requests together before either has resolved", async () => {
  const ownSummary = { ...summary, connections: new Map([["call", {
    ...summary.connections.get("call")!, hasOwnSeries: true,
  }]]) };
  const load = vi.fn(() => new Promise<NodeSeriesMetrics[]>(() => {}));
  const loadConnections = vi.fn(() => new Promise<never>(() => {}));
  const loader = { load, loadConnections };
  const { result } = renderHook(() => usePlayback({
    runId: "run-1", variant: "baseline", pointId: "p0", replication: 0,
    window: 0, windowCount: 70, nodes: ["dependency"], results: ownSummary, onWindowChange: vi.fn(),
  }, loader));
  expect(load.mock.calls.length).toBeGreaterThan(0);
  expect(loadConnections).toHaveBeenCalled();
  expect(result.current.loading).toBe(true);
});

function connectionRange(request: ConnectionSeriesLoadRequest): DecodedConnection[] {
  return [{ id: "call", windows: Array.from({ length: request.untilWindow - request.fromWindow }, (_, offset) => ({
    failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
    startMs: (request.fromWindow + offset) * 100, durationMs: 100,
    sentAttempts: request.fromWindow + offset + 1, retries: 1, timeouts: 1, succeeded: 1, failed: 0, orphaned: 1,
    inFlightIntegralMs: 20, orphanedIntegralMs: 50, backoffIntegralMs: 10,
    latency: { count: 1, sumMs: 12, meanMs: 12, p50Ms: 12, p95Ms: 12, p99Ms: 12 }, slotPools: {},
  })) }];
}

it.each([
  { speed: 1, beforeMs: 720, before: 31, crossMs: 80, after: 32, nextMs: 120 },
  { speed: 4, beforeMs: 160, before: 30, crossMs: 40, after: 32, nextMs: 40 },
])("keeps the clock running across a prepared chunk at $speed× without loading its metrics again", async ({ speed, beforeMs, before, crossMs, after, nextMs }) => {
  vi.useFakeTimers();
  const requests: SeriesLoadRequest[] = [];
  const connectionRequests: ConnectionSeriesLoadRequest[] = [];
  const ownSummary = { ...summary, connections: new Map([["call", {
    ...summary.connections.get("call")!, hasOwnSeries: true,
  }]]) };
  const loader = {
    load: async (request: SeriesLoadRequest) => { requests.push(request); return range(request); },
    loadConnections: async (request: ConnectionSeriesLoadRequest) => { connectionRequests.push(request); return connectionRange(request); },
  };
  const { result } = setup(loader, 100, ["dependency"], ownSummary);
  await act(async () => result.current.seek(24));
  act(() => { result.current.setSpeed(speed); result.current.play(); });
  await act(async () => vi.advanceTimersByTime(beforeMs));
  expect(result.current.window).toBe(before);
  const clearInterval = vi.spyOn(globalThis, "clearInterval");
  await act(async () => vi.advanceTimersByTime(crossMs));
  expect(result.current.window).toBe(after);
  expect(result.current.loading).toBe(false);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(32);
  expect(result.current.frame?.connections.get("call")?.values.sentAttemptsPerSecond).toBe(330);
  expect(clearInterval).not.toHaveBeenCalled();
  expect(requests.filter(request => request.fromWindow === 32)).toHaveLength(1);
  expect(connectionRequests.filter(request => request.fromWindow === 32)).toHaveLength(1);
  act(() => vi.advanceTimersByTime(nextMs));
  expect(result.current.window).toBe(33);
  clearInterval.mockRestore();
});

it("retains only the current and next chunks, evicting older prepared metrics", async () => {
  const requests: SeriesLoadRequest[] = [];
  const loader = { load: async (request: SeriesLoadRequest) => { requests.push(request); return range(request); } };
  const { result } = setup(loader, 160);
  await act(async () => result.current.seek(24));
  expect(requests.map(request => request.fromWindow)).toEqual([0, 32]);
  await act(async () => result.current.seek(56));
  expect(requests.map(request => request.fromWindow)).toEqual([0, 32, 64]);
  await act(async () => result.current.seek(88));
  expect(requests.map(request => request.fromWindow)).toEqual([0, 32, 64, 96]);
  await act(async () => result.current.seek(56));
  expect(requests.map(request => request.fromWindow)).toEqual([0, 32, 64, 96, 32]);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(56);
  await act(async () => result.current.seek(120));
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(120);
  await act(async () => result.current.seek(88));
  expect(requests.filter(request => request.fromWindow === 64)).toHaveLength(2);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(88);
});

it("aborts obsolete speculative requests and does not retain their late replies after a far seek", async () => {
  const pending: { request: SeriesLoadRequest; resolve: (nodes: NodeSeriesMetrics[]) => void }[] = [];
  const loader = { load: (request: SeriesLoadRequest) => new Promise<NodeSeriesMetrics[]>(resolve => pending.push({ request, resolve })) };
  const { result } = setup(loader, 160);
  await act(async () => result.current.seek(24));
  await act(async () => pending[0].resolve(range(pending[0].request)));
  const speculative = pending.find(item => item.request.fromWindow === 32)!;
  await act(async () => result.current.seek(96));
  expect(speculative.request.signal?.aborted).toBe(true);
  await act(async () => speculative.resolve(range(speculative.request)));
  expect(result.current.loading).toBe(true);
  expect(result.current.frame?.window).toBe(24);
  await act(async () => result.current.seek(32));
  const current = pending.filter(item => item.request.fromWindow === 32);
  expect(current).toHaveLength(2);
  expect(result.current.loading).toBe(true);
  await act(async () => current[1].resolve(range(current[1].request)));
  expect(result.current.frame?.window).toBe(32);
  expect(result.current.frame?.pending).toBeUndefined();
});

it("does not redraw the current frame when the next chunk finishes preparing", async () => {
  const pending: { request: SeriesLoadRequest; resolve: (nodes: NodeSeriesMetrics[]) => void }[] = [];
  const loader = { load: (request: SeriesLoadRequest) => new Promise<NodeSeriesMetrics[]>(resolve => pending.push({ request, resolve })) };
  let renders = 0;
  const { result, rerender } = renderHook(({ window }) => {
    renders++;
    return usePlayback({
      runId: "run-1", variant: "baseline", pointId: "p0", replication: 0,
      window, windowCount: 100, nodes: ["dependency"], results: summary, onWindowChange: vi.fn(),
    }, loader);
  }, { initialProps: { window: 24 } });
  await act(async () => pending[0].resolve(range(pending[0].request)));
  const before = renders;
  await act(async () => pending[1].resolve(range(pending[1].request)));
  expect(renders).toBe(before);
  rerender({ window: 32 });
  expect(result.current.loading).toBe(false);
  expect(result.current.frame?.services.get("dependency")?.values.meanQueue).toBe(32);
});

it.each(["loading", "prepared", "after the boundary"])("freezes the cursor at a chunk boundary (%s) and resumes from the paused window", async (phase) => {
  vi.useFakeTimers();
  let resolveNext!: () => void;
  const loader = { load: async (request: SeriesLoadRequest) => {
    if (phase === "loading" && request.fromWindow === 32) {
      return new Promise<NodeSeriesMetrics[]>(resolve => { resolveNext = () => resolve(range(request)); });
    }
    return range(request);
  } };
  const { result } = setup(loader, 100);
  await act(async () => result.current.seek(31));
  act(() => result.current.play());
  await act(async () => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(32);
  expect(result.current.loading).toBe(phase === "loading");
  if (phase === "after the boundary") act(() => vi.advanceTimersByTime(120));
  act(() => result.current.pause());
  expect(result.current.playing).toBe(false);
  if (phase === "loading") await act(async () => resolveNext());
  const paused = phase === "after the boundary" ? 33 : 32;
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.window).toBe(paused);
  expect(result.current.frame?.window).toBe(paused);
  act(() => result.current.play());
  act(() => vi.advanceTimersByTime(120));
  expect(result.current.window).toBe(phase === "after the boundary" ? 34 : 33);
  expect(result.current.playing).toBe(true);
});
