import { describe, expect, it } from "vitest";
import type { components } from "../../api/schema";
import { decodeSeriesPart } from "./decode";

type RawWindow = components["schemas"]["WindowMetrics"];
type RawPart = components["schemas"]["SeriesPart"];

function window(values: Partial<RawWindow>): RawWindow {
  return {
    startMs: 0,
    durationMs: 10,
    originalArrivals: 0,
    offeredAttempts: 0,
    admittedAttempts: 0,
    queueRejections: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    retries: 0,
    busyHandlerTimeMs: 0,
    handlers: 0,
    queueLengthIntegralMs: 0,
    latency: { count: 0, sumMs: 0, sketch: [0] },
    ...values,
  };
}

function part(nodes: RawPart["nodes"]): RawPart {
  return { schemaVersion: 1, profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 2, nodes };
}

describe("window metrics", () => {
  it("uses artifact formulas for client, service and amplification", () => {
    const decoded = decodeSeriesPart(JSON.stringify(part([
      { id: "client", windows: [
        window({ originalArrivals: 20, successes: 15, failures: 5, latency: { count: 20, sumMs: 100, sketch: [0, 0, 20] } }),
        window({ startMs: 10, durationMs: 5 }),
      ] },
      { id: "service", windows: [
        window({
          offeredAttempts: 30,
          admittedAttempts: 24,
          queueRejections: 6,
          successes: 18,
          failures: 6,
          timeouts: 4,
          retries: 8,
          busyHandlerTimeMs: 40,
          handlers: 4,
          queueLengthIntegralMs: 50,
          latency: { count: 24, sumMs: 240, sketch: [0, 64, 24] },
        }),
        window({ startMs: 10, durationMs: 5, handlers: 4 }),
      ] },
    ])));

    const client = decoded.nodes[0].windows[0].metrics;
    expect(client).toEqual({
      startMs: 0,
      durationMs: 10,
      originalArrivalsPerSecond: 2000,
      offeredAttemptsPerSecond: 0,
      admittedAttemptsPerSecond: 0,
      queueRejectionsPerSecond: 0,
      successesPerSecond: 1500,
      failuresPerSecond: 500,
      timeoutsPerSecond: 0,
      retriesPerSecond: 0,
      handlerUtilization: null,
      meanQueueLength: null,
      meanLatencyMs: 5,
      p50LatencyMs: 1.0078125,
      p95LatencyMs: 1.0078125,
      p99LatencyMs: 1.0078125,
      amplification: null,
    });
    expect(decoded.nodes[1].windows[0].metrics).toEqual({
      startMs: 0,
      durationMs: 10,
      originalArrivalsPerSecond: 0,
      offeredAttemptsPerSecond: 3000,
      admittedAttemptsPerSecond: 2400,
      queueRejectionsPerSecond: 600,
      successesPerSecond: 1800,
      failuresPerSecond: 600,
      timeoutsPerSecond: 400,
      retriesPerSecond: 800,
      handlerUtilization: 1,
      meanQueueLength: 5,
      meanLatencyMs: 10,
      p50LatencyMs: 2.015625,
      p95LatencyMs: 2.015625,
      p99LatencyMs: 2.015625,
      amplification: 1.2,
    });
  });

  it("gives an empty service window zero load and queue but no latency or amplification", () => {
    const decoded = decodeSeriesPart(JSON.stringify(part([
      { id: "client", windows: [window({}), window({ startMs: 10, durationMs: 5 })] },
      { id: "service", windows: [window({ handlers: 4 }), window({ startMs: 10, durationMs: 5, handlers: 4 })] },
    ])));

    expect(decoded.nodes[1].windows[1].metrics).toEqual({
      startMs: 10,
      durationMs: 5,
      originalArrivalsPerSecond: 0,
      offeredAttemptsPerSecond: 0,
      admittedAttemptsPerSecond: 0,
      queueRejectionsPerSecond: 0,
      successesPerSecond: 0,
      failuresPerSecond: 0,
      timeoutsPerSecond: 0,
      retriesPerSecond: 0,
      handlerUtilization: 0,
      meanQueueLength: 0,
      meanLatencyMs: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
      amplification: null,
    });
  });

  it("rejects the part wire profile instead of interpreting it as bitwise6", () => {
    const invalid = part([{ id: "client", windows: [window({}), window({ startMs: 10 })] }]);
    invalid.profile = "other";

    expect(() => decodeSeriesPart(JSON.stringify(invalid))).toThrow("Unsupported sketch profile: other");
  });
});
