import type { ConnectionWindowMetrics } from "../../api/apiTypes";
import type { components } from "../../api/schema";
import { LatencySketch } from "./sketch";
import { MessageError } from "../../i18n/MessageError";
import type { DecodedConnectionWindow, DecodedSeriesPart, DecodedWindow } from "./types";

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
  return { ...window, latency: decodeLatency(window.latency, profile) };
}

function decodeWindow(window: RawWindow, originalArrivals: number, profile: string): DecodedWindow {
  return {
    originalArrivals: window.originalArrivals,
    admittedAttempts: window.admittedAttempts,
    handlers: window.handlers,
    latency: { count: window.latency.count, sumMs: window.latency.sumMs },
    metrics: { ...window, latency: decodeLatency(window.latency, profile), client: { originalArrivals } },
  };
}

function decodeLatency(latency: RawWindow["latency"], profile: string) {
  const sketch = LatencySketch.decode(profile, latency.sketch);
  return {
    count: latency.count, sumMs: latency.sumMs,
    meanMs: latency.count === 0 ? null : latency.sumMs / latency.count,
    p50Ms: sketch.quantile(0.50), p95Ms: sketch.quantile(0.95), p99Ms: sketch.quantile(0.99),
  };
}
