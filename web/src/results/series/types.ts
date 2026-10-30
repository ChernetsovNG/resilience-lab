import type { ConnectionWindowMetrics, WindowMetrics } from "../../api/apiTypes";

export type WindowMetricValues = Omit<WindowMetrics, "latency"> & {
  latency: DecodedConnectionLatency;
  /** Window approximation: admitted attempts may belong to client requests that arrived in earlier windows. */
  client?: { originalArrivals: number };
};

export interface DecodedWindow {
  originalArrivals: number;
  admittedAttempts: number;
  hasSlots: boolean;
  metrics: WindowMetricValues;
  latency: { count: number; sumMs: number };
}

export interface DecodedNode {
  id: string;
  windows: DecodedWindow[];
}

/** Latency includes only attempts with a received response; timeouts do not contribute samples. */
export interface DecodedConnectionLatency {
  count: number;
  sumMs: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export type DecodedConnectionWindow = Omit<ConnectionWindowMetrics, "latency"> & {
  latency: DecodedConnectionLatency;
};

export interface DecodedConnection {
  id: string;
  windows: DecodedConnectionWindow[];
}

export interface DecodedSeriesPart {
  fromWindow: number;
  untilWindow: number;
  nodes: DecodedNode[];
  connections: DecodedConnection[];
}

export interface NodeSeriesMetrics {
  id: string;
  windows: WindowMetricValues[];
  /** Raw sample weights, aligned with windows, for pooled latency within a replication. */
  latency?: { count: number; sumMs: number }[];
}
