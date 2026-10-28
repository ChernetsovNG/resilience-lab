export interface WindowMetricValues {
  startMs: number;
  durationMs: number;
  originalArrivalsPerSecond: number;
  offeredAttemptsPerSecond: number;
  admittedAttemptsPerSecond: number;
  queueRejectionsPerSecond: number;
  successesPerSecond: number;
  failuresPerSecond: number;
  timeoutsPerSecond: number;
  retriesPerSecond: number;
  handlerUtilization: number | null;
  meanQueueLength: number | null;
  meanLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  /** Window approximation: admitted attempts may belong to client requests that arrived in earlier windows. */
  amplification: number | null;
}

export interface DecodedWindow {
  originalArrivals: number;
  admittedAttempts: number;
  handlers: number;
  metrics: WindowMetricValues;
}

export interface DecodedNode {
  id: string;
  windows: DecodedWindow[];
}

export interface DecodedSeriesPart {
  fromWindow: number;
  untilWindow: number;
  nodes: DecodedNode[];
}

export interface NodeSeriesMetrics {
  id: string;
  windows: WindowMetricValues[];
}
