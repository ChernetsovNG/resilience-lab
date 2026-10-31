import { describe, expect, it } from "vitest";
import type { components } from "../../api/schema";
import { decodeSeriesPart } from "./decode";

type RawWindow = components["schemas"]["ConnectionWindowMetrics"];
type RawPart = components["schemas"]["SeriesPart"];

function window(values: Partial<RawWindow> = {}): RawWindow {
  return { startMs: 0,
      durationMs: 10,
      sentAttempts: 0,
      retries: 0,
      succeeded: 0,
      failed: 0,
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
      timeouts: 0,
      orphaned: 0,
      inFlightIntegralMs: 0,
      orphanedIntegralMs: 0,
      backoffIntegralMs: 0,
      latency: { count: 0, sumMs: 0, sketch: [0] },
      slotPools: {  }, ...values };
}

function part(windows: RawWindow[] = [window()]): RawPart {
  return {
    schemaVersion: 7,
    kind: "INSTANCE",
    profile: "ddsketch-bitwise6-rational-v1",
    fromWindow: 0,
    untilWindow: windows.length,
    nodes: [],
    classes: [],
    connections: [{ id: "client-to-service", windows }],
  };
}

describe("connection window decoding", () => {
  it("retains common slot fields in schema 7", () => {
    const slot = { busyIntegralMs: 8, queueIntegralMs: 4, capacityIntegralMs: 10,
      waitCount: 2, totalWaitMs: 4, queueFullCount: 0, waitLimitCount: 1 };
    const raw = { schemaVersion: 7, kind: "INSTANCE", profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 1,
      nodes: [], classes: [], connections: [{ id: "pooled", windows: [{
        failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs: 0, durationMs: 10,
        sentAttempts: 1, retries: 0, succeeded: 1, failed: 0, timeouts: 0, orphaned: 0,
        inFlightIntegralMs: 8, orphanedIntegralMs: 0, backoffIntegralMs: 0,
        latency: { count: 0, sumMs: 0, sketch: [0] }, slotPools: { pool: slot } }] }] };
    expect(decodeSeriesPart(JSON.stringify(raw)).connections[0].windows[0]).toMatchObject({ slotPools: { pool: slot } });
  });

  it("decodes response latency without counting timed out attempts as responses", () => {
    const raw = part([window({ sentAttempts: 5,
      retries: 1,
      succeeded: 2,
      failed: 1,
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
      timeouts: 2,
      orphaned: 1,
      inFlightIntegralMs: 24,
      orphanedIntegralMs: 4,
      backoffIntegralMs: 3,
      latency: { count: 3, sumMs: 3, sketch: [1, 0, 1, 64, 1] },
      slotPools: {  } })]);

    const decoded = decodeSeriesPart(JSON.stringify(raw));

    expect(decoded.nodes).toEqual([]);
    expect(decoded.connections).toEqual([{
      id: "client-to-service",
      windows: [{ startMs: 0,
      durationMs: 10,
      sentAttempts: 5,
      retries: 1,
      succeeded: 2,
      failed: 1,
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
      timeouts: 2,
      orphaned: 1,
      inFlightIntegralMs: 24,
      orphanedIntegralMs: 4,
      backoffIntegralMs: 3,
      latency: { count: 3, sumMs: 3, meanMs: 1, p50Ms: 1.0078125, p95Ms: 2.015625, p99Ms: 2.015625 },
      slotPools: {  } }],
    }]);
  });

  it("keeps a timeout-only window without inventing response latency", () => {
    const raw = part([window({ sentAttempts: 1, timeouts: 1, orphaned: 1 })]);

    const decoded = decodeSeriesPart(JSON.stringify(raw));

    expect(decoded.connections[0].windows[0].latency).toEqual({
      count: 0, sumMs: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null,
    });
  });

  it("decodes connection windows alongside node windows", () => {
    const raw = part();
    raw.nodes = [{ id: "client", windows: [{ startMs: 0,
      durationMs: 10,
      originalArrivals: 2,
      offeredAttempts: 0,
      admittedAttempts: 0,
      successes: 1,
      failures: 1,
      failuresByReason: {}, degraded: 0, rateLimited: 0, probes: 0,
      probeFailures: 0, notReadyMs: 0, ejections: 0, ejectedMs: 0,
      timeouts: 0,
      retries: 0,
      latency: { count: 0, sumMs: 0, sketch: [0] },
      slotPools: {  } }] }];

    const decoded = decodeSeriesPart(JSON.stringify(raw));

    expect(decoded.nodes[0].windows[0].metrics.originalArrivals).toBe(2);
    expect(decoded.connections[0].id).toBe("client-to-service");
  });

  it.each([1, 2, 3, 4, 5, 6, 8])("rejects unsupported part schema version %s", (schemaVersion) => {
    expect(() => decodeSeriesPart(JSON.stringify({ ...part(), schemaVersion }))).toThrow(/schema version/i);
  });

  it("validates the sketch profile in a connection-only part", () => {
    const raw = { ...part(), profile: "other" };

    expect(() => decodeSeriesPart(JSON.stringify(raw))).toThrow("Unsupported sketch profile: other");
  });

  it("rejects a noncanonical connection latency sketch", () => {
    const raw = part([window({ latency: { count: 0, sumMs: 0, sketch: [0, 64, 0] } })]);

    expect(() => decodeSeriesPart(JSON.stringify(raw))).toThrow();
  });

  it("rejects connection windows that do not cover the containing part", () => {
    const raw = { ...part(), untilWindow: 2 };

    expect(() => decodeSeriesPart(JSON.stringify(raw))).toThrow(/window/i);
  });

  it("rejects a connection window with no duration", () => {
    const raw = part([window({ durationMs: 0 })]);

    expect(() => decodeSeriesPart(JSON.stringify(raw))).toThrow(/window/i);
  });
});
