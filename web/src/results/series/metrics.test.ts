import { calculateOutput, outputWindow, outputsOf } from "../outputs";
import { catalog } from "../../test/fixtures";
import { describe, expect, it } from "vitest";
import type { components } from "../../api/schema";
import { decodeSeriesPart } from "./decode";

type RawWindow = components["schemas"]["WindowMetrics"];
type RawPart = components["schemas"]["SeriesPart"];

function window(values: Partial<RawWindow>): RawWindow {
  return { startMs: 0,
      durationMs: 10,
      originalArrivals: 0,
      clientOriginalArrivals: values.originalArrivals ?? 0,
      offeredAttempts: 0,
      admittedAttempts: 0,
      successes: 0,
      failures: 0,
      failuresByReason: {}, degraded: 0, rateLimited: 0, probes: 0,
      probeFailures: 0, notReadyMs: 0, ejections: 0, ejectedMs: 0,
      timeouts: 0,
      retries: 0,
      latency: { count: 0, sumMs: 0, sketch: [0] },
      slotPools: {  }, ...values };
}

function part(nodes: RawPart["nodes"]): RawPart {
  return { schemaVersion: 7, kind: "INSTANCE", profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 2, nodes, classes: [], connections: [] };
}

describe("window metrics", () => {
  it("uses artifact formulas for client, service and amplification", () => {
    const decoded = decodeSeriesPart(JSON.stringify(part([
      { id: "client", windows: [
        window({ originalArrivals: 20, successes: 15, failures: 5, latency: { count: 20, sumMs: 100, sketch: [0, 0, 20] } }),
        window({ startMs: 10, durationMs: 5 }),
      ] },
      { id: "service", windows: [
        window({ offeredAttempts: 30, clientOriginalArrivals: 20,
      admittedAttempts: 24,
      successes: 18,
      failures: 6,
      timeouts: 4,
      retries: 8,
      latency: { count: 24, sumMs: 240, sketch: [0, 64, 24] },
      slotPools: { handlers: { busyIntegralMs: 40, queueIntegralMs: 50, capacityIntegralMs: (4) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 6, waitLimitCount: 0 } } }),
        window({ startMs: 10,
      durationMs: 5,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (4) * (5), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }),
      ] },
    ])));

    const client = outputWindow(outputsOf(catalog, "client"), decoded.nodes[0].windows[0].metrics);
    expect(client).toEqual({ startMs: 0, durationMs: 10, originalArrivalsPerSecond: 2000,
      successesPerSecond: 1500, failuresPerSecond: 500, meanLatencyMs: 5,
      p50LatencyMs: 1.0078125, p95LatencyMs: 1.0078125, p99LatencyMs: 1.0078125 });
    const frame = decoded.nodes[1].windows[0].metrics;
    expect(calculateOutput(outputsOf(catalog, "request")[0].calculation, { target: frame, entries: frame.entries })).toBe(1.2);
    expect(outputWindow(outputsOf(catalog, "service"), frame)).toMatchObject({
      startMs: 0,
      durationMs: 10,
      offeredAttemptsPerSecond: 3000,
      admittedAttemptsPerSecond: 2400,
      queueRejectionsPerSecond: 600,
      successesPerSecond: 1800,
      failuresPerSecond: 600,
      timeoutsPerSecond: 400,
      retriesPerSecond: 800,
      utilization: 1,
      meanQueue: 5,
      meanLatencyMs: 10,
      p50LatencyMs: 2.015625,
      p95LatencyMs: 2.015625,
      p99LatencyMs: 2.015625,
    });
  });

  it("gives an empty service window zero load and queue but no latency or amplification", () => {
    const decoded = decodeSeriesPart(JSON.stringify(part([
      { id: "client", windows: [window({}), window({ startMs: 10, durationMs: 5 })] },
      { id: "service", windows: [window({ slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (4) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }), window({ startMs: 10,
      durationMs: 5,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (4) * (5), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } })] },
    ])));

    expect(outputWindow(outputsOf(catalog, "service"), decoded.nodes[1].windows[1].metrics)).toMatchObject({
      startMs: 10,
      durationMs: 5,
      offeredAttemptsPerSecond: 0,
      admittedAttemptsPerSecond: 0,
      queueRejectionsPerSecond: 0,
      successesPerSecond: 0,
      failuresPerSecond: 0,
      timeoutsPerSecond: 0,
      retriesPerSecond: 0,
      utilization: 0,
      meanQueue: 0,
      meanLatencyMs: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
    });
  });

  it("rejects the part wire profile instead of interpreting it as bitwise6", () => {
    const invalid = part([{ id: "client", windows: [window({}), window({ startMs: 10 })] }]);
    invalid.profile = "other";

    expect(() => decodeSeriesPart(JSON.stringify(invalid))).toThrow("Unsupported sketch profile: other");
  });
});
