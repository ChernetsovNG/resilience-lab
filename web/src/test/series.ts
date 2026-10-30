import type { WindowMetricValues } from "../results/series";

/** Complete recorded row for view tests; individual tests supply the raw counters they exercise. */
export function recordedWindow(values: Partial<WindowMetricValues> = {}): WindowMetricValues {
  return { startMs: 0,
      durationMs: 100,
      originalArrivals: 0,
      offeredAttempts: 0,
      admittedAttempts: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      retries: 0,
      latency: { count: 0, sumMs: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      client: { originalArrivals: 0 },
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: values.durationMs ?? 100, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } }, ...values };
}
