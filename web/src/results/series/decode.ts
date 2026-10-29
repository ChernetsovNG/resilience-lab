import type { ConnectionWindowMetrics } from "../../api/apiTypes";
import type { components } from "../../api/schema";
import { LatencySketch } from "./sketch";
import { MessageError } from "../../i18n/MessageError";
import type { DecodedConnectionWindow, DecodedSeriesPart, DecodedWindow, WindowMetricValues } from "./types";

type RawPart = components["schemas"]["SeriesPart"];
type RawWindow = components["schemas"]["WindowMetrics"];

/** Parses one browser-decompressed part and turns every sketch into numeric window metrics. */
export function decodeSeriesPart(text: string): DecodedSeriesPart {
  const part = JSON.parse(text) as RawPart;
  if (part.schemaVersion !== 2) throw new MessageError("results.series.unsupportedPartSchema", { version: String(part.schemaVersion) });
  for (const connection of part.connections) {
    if (connection.windows.length !== part.untilWindow - part.fromWindow || connection.windows.some((window) =>
      !Number.isFinite(window.startMs) || window.startMs < 0 || !Number.isFinite(window.durationMs) || window.durationMs <= 0,
    )) throw new MessageError("results.series.invalidConnectionWindows");
  }
  const arrivals = new Map<number, number>();
  for (const node of part.nodes) {
    for (const [offset, window] of node.windows.entries()) {
      const index = part.fromWindow + offset;
      arrivals.set(index, (arrivals.get(index) ?? 0) + window.originalArrivals);
    }
  }
  return {
    fromWindow: part.fromWindow,
    untilWindow: part.untilWindow,
    nodes: part.nodes.map((node) => ({
      id: node.id,
      windows: node.windows.map((window, offset) =>
        decodeWindow(window, arrivals.get(part.fromWindow + offset) ?? 0, part.profile),
      ),
    })),
    connections: part.connections.map((connection) => ({
      id: connection.id,
      windows: connection.windows.map((window) => decodeConnectionWindow(window, part.profile)),
    })),
  };
}

function decodeConnectionWindow(window: ConnectionWindowMetrics, profile: string): DecodedConnectionWindow {
  const sketch = LatencySketch.decode(profile, window.latency.sketch);
  return {
    ...window,
    latency: {
      count: window.latency.count,
      sumMs: window.latency.sumMs,
      meanMs: window.latency.count === 0 ? null : window.latency.sumMs / window.latency.count,
      p50Ms: sketch.quantile(0.50),
      p95Ms: sketch.quantile(0.95),
      p99Ms: sketch.quantile(0.99),
    },
  };
}

function decodeWindow(window: RawWindow, originalArrivals: number, profile: string): DecodedWindow {
  const sketch = LatencySketch.decode(profile, window.latency.sketch);
  const metrics = metricsOf(window, sketch);
  if (window.handlers > 0) {
    metrics.amplification = originalArrivals === 0 ? null : window.admittedAttempts / originalArrivals;
  }
  return {
    originalArrivals: window.originalArrivals,
    admittedAttempts: window.admittedAttempts,
    handlers: window.handlers,
    latency: { count: window.latency.count, sumMs: window.latency.sumMs },
    metrics,
  };
}

function metricsOf(window: RawWindow, sketch: LatencySketch): WindowMetricValues {
  const rate = (count: number) => count * 1000 / window.durationMs;
  const service = window.handlers > 0;
  return {
    startMs: window.startMs,
    durationMs: window.durationMs,
    originalArrivalsPerSecond: rate(window.originalArrivals),
    offeredAttemptsPerSecond: rate(window.offeredAttempts),
    admittedAttemptsPerSecond: rate(window.admittedAttempts),
    queueRejectionsPerSecond: rate(window.queueRejections),
    successesPerSecond: rate(window.successes),
    failuresPerSecond: rate(window.failures),
    timeoutsPerSecond: rate(window.timeouts),
    retriesPerSecond: rate(window.retries),
    handlerUtilization: service ? window.busyHandlerTimeMs / (window.handlers * window.durationMs) : null,
    meanQueueLength: service ? window.queueLengthIntegralMs / window.durationMs : null,
    meanLatencyMs: window.latency.count === 0 ? null : window.latency.sumMs / window.latency.count,
    p50LatencyMs: sketch.quantile(0.50),
    p95LatencyMs: sketch.quantile(0.95),
    p99LatencyMs: sketch.quantile(0.99),
    amplification: null,
  };
}
