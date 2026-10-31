import { recordedWindow } from "../test/series";
import { describe, expect, it } from "vitest";
import type { NodeSeriesMetrics, WindowMetricValues } from "../results/series/types";
import { catalog, experiment, manifest, model, summary } from "../test/fixtures";
import { projectElementResults, type ElementResultsContext } from "./elementResultsData";

const window = (startMs: number, durationMs: number, meanLatencyMs: number | null = 20): WindowMetricValues => recordedWindow({ startMs,
      durationMs,
      offeredAttempts: durationMs / 5,
      admittedAttempts: durationMs * 0.19,
      latency: { count: meanLatencyMs == null ? 0 : 1, sumMs: meanLatencyMs ?? 0, meanMs: meanLatencyMs,
    p50Ms: meanLatencyMs, p95Ms: meanLatencyMs, p99Ms: meanLatencyMs },
      entries: { total: { originalArrivals: durationMs * 0.19 / 2.25 } },
      slotPools: { handlers: { busyIntegralMs: durationMs * 0.75, queueIntegralMs: durationMs * 2, capacityIntegralMs: durationMs, waitCount: 0, totalWaitMs: 0, queueFullCount: durationMs / 100, waitLimitCount: 0 } } });
function fixture(): ElementResultsContext {
  const run = structuredClone(summary);
  run.variants[0].points[0].aggregate.services.middle = {
    ...run.variants[0].points[0].aggregate.services.gateway,
    admittedAmplification: { count: 2, mean: 2, min: 1.5, max: 2.5, ci95Low: 1.5, ci95High: 2.5 },
  };
  run.variants[0].points[0].coordinates = { "gateway-to-middle.timeout": "150ms" };
  run.variants[0].points[0].aggregate.connections["gateway-to-middle"] = {
    slotPoolSummaries: {},
    totals: {
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, measurementMs: 2000,
      sentAttempts: 30,
      retries: 10,
      succeeded: 20,
      failed: 4,
      timeouts: 6,
      orphaned: 4,
      inFlightIntegralMs: 5000,
      orphanedIntegralMs: 300,
      backoffIntegralMs: 100,
      slotPools: {  } },
    timeoutRate: { count: 2, mean: 0.25, min: 0, max: 0.5, ci95Low: -0.1, ci95High: 0.7 },
    meanInFlight: { count: 2, mean: 3, min: 2, max: 4, ci95Low: 1, ci95High: 5 },
    pooledLatency: { meanMs: 22, p95Ms: 30, p99Ms: 40, statistics: { count: 24, sumMs: 528, sketch: [24] } },
  };
  const nodes: NodeSeriesMetrics[] = [{ id: "gateway", windows: [window(0, 100, 999),
    window(100, 100, 10), window(200, 900, 50), window(1100, 25)],
    latency: [{ count: 1, sumMs: 999 }, { count: 1, sumMs: 10 }, { count: 9, sumMs: 450 }, { count: 2, sumMs: 40 }],
  }, { id: "middle", windows: [window(0, 100), window(100, 100), window(200, 900), window(1100, 25)] }];
  return { summary: run, manifest: { ...manifest, series: { ...manifest.series!, measurementMs: 1025, windowMs: 100 } },
    runModel: model, currentModel: model, experiment, catalog, variantId: "baseline", pointId: "p0", replication: 0,
    window: null, selected: "gateway", nodes,
    connections: [{ id: "gateway-to-middle", windows: [0, 100, 200, 1100].map(startMs => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: 25,
      sentAttempts: 4,
      retries: 1,
      succeeded: 1,
      failed: 1,
      timeouts: 2,
      orphaned: 2,
      inFlightIntegralMs: 6,
      orphanedIntegralMs: 3,
      backoffIntegralMs: 2,
      latency: { count: 2, sumMs: 24, meanMs: 12, p50Ms: 12, p95Ms: 12, p99Ms: 12 },
      slotPools: {  } })) }] };
}
const values = (context: ElementResultsContext) => projectElementResults(context)!.values;

describe("element results sources", () => {
  it("resolves client summary bindings from the selected client's actual ID", () => {
    const context = fixture();
    const runModel = { ...model, blocks: { ...model.blocks,
      "mobile-app": model.blocks.client, "partner-api": model.blocks.client } };
    context.runModel = runModel;
    context.currentModel = runModel;
    context.selected = "partner-api";
    const client = catalog.types.find(type => type.id === "client")!;
    context.catalog = { ...catalog, types: catalog.types.map(type => type.id !== "client" ? type : {
      ...client, outputs: [{ ...client.outputs[0], id: "successRate", unit: "PERCENT", kind: "RATIO",
        calculation: { kind: "RATIO", field: "successes", divisor: "originalArrivals" },
        summary: { source: "POOLED", intervalField: "successRate", calculation: { kind: "VALUE", field: "successRate.mean" } },
        inspector: { order: 0, title: "Success rate", showValue: true } }],
    }) };
    const entry = (mean: number) => ({ pooledLatency: {}, failuresByReason: {},
      successRate: { count: 2, mean, min: mean, max: mean } });
    context.summary.variants[0].points[0].aggregate.entries.clients = {
      "mobile-app": entry(0.5), "partner-api": entry(0.9),
    };
    expect(projectElementResults(context)?.values.successRate).toMatchObject({ value: 0.9, source: "replications" });
  });
  it("uses pooled service totals and sample-weighted measurement-window latency of the selected replication", () => {
    const result = values(fixture());
    expect(result.utilization).toMatchObject({ value: 0.5, source: "pooled" });
    expect(result.meanQueue.value).toBe(0.1);
    expect(result.queueFill.value).toBe(0.1 / 16);
    expect(result.queueRejectionRate.value).toBe(20 / 260);
    expect(result.admittedAttemptsPerSecond.value).toBe(120);
    expect(result.meanLatencyMs.source).toBe("replication");
    expect(result.meanLatencyMs.value).toBeCloseTo(500 / 12);
    expect(result.utilization.ci95Low).toBeUndefined();
  });
  it("uses the exact service window instead of pooled values", () => {
    const result = values({ ...fixture(), window: 3 });
    expect(result.utilization).toEqual({ value: 0.75, source: "window" });
    expect(result.meanQueue.value).toBe(2);
    expect(result.queueFill.value).toBe(2 / 16);
    expect(result.queueRejectionRate.value).toBe(0.05);
    expect(result.admittedAttemptsPerSecond.value).toBe(190);
    expect(result.meanLatencyMs.value).toBe(20);
  });
  it("uses a call's own totals, pooled response latency and available replication confidence intervals", () => {
    const context = { ...fixture(), selected: "gateway-to-middle" };
    const result = values(context);
    expect(result.sentAttemptsPerSecond.value).toBe(15);
    expect(result.retriesPerSecond.value).toBe(5);
    expect(result.timeoutRate).toMatchObject({ value: 0.25, source: "replications", ci95Low: -0.1, ci95High: 0.7 });
    expect(result.meanInFlight).toMatchObject({ value: 3, source: "replications", ci95Low: 1, ci95High: 5 });
    expect(result.orphaned).toEqual({ value: 2, source: "perReplication" });
    expect(result.meanOrphaned.value).toBe(0.15);
    expect(result.meanBackoff.value).toBe(0.05);
    expect(result.meanLatencyMs).toEqual({ value: 22, source: "pooled" });
    expect(result.amplification).toMatchObject({ value: 2, ci95Low: 1.5, ci95High: 2.5 });
    expect(projectElementResults(context)!.timeoutMs).toBe(150);
  });
  it.each([[1, 11], [3, 3.6666666667], [10, 1.1]])("normalizes orphaned attempts by all %s replications", (replications, expected) => {
    const context = { ...fixture(), selected: "gateway-to-middle" };
    context.summary.variants[0].replications = replications;
    context.summary.variants[0].points[0].aggregate.connections["gateway-to-middle"].totals.orphaned = 11;
    const orphaned = values(context).orphaned;
    expect(orphaned.value).toBeCloseTo(expected);
    expect(orphaned.source).toBe("perReplication");
  });
  it("uses call event counts and partial-window duration, with only target amplification from the node", () => {
    const result = values({ ...fixture(), selected: "gateway-to-middle", window: 3 });
    expect(result.sentAttemptsPerSecond.value).toBe(160);
    expect(result.retriesPerSecond.value).toBe(40);
    expect(result.timeoutRate).toEqual({ value: 0.5, source: "window" });
    expect(result.orphaned.value).toBe(2);
    expect(result.meanOrphaned.value).toBe(0.12);
    expect(result.meanInFlight.value).toBe(0.24);
    expect(result.meanBackoff.value).toBe(0.08);
    expect(result.meanLatencyMs.value).toBe(12);
    expect(result.amplification.value).toBe(2.25);
    expect(result.amplification.approximate).toBe(true);
  });
  it("never substitutes another context or a replaced element with the same ID", () => {
    expect(projectElementResults({ ...fixture(), selected: "new-service" })).toBeNull();
    expect(projectElementResults({ ...fixture(), selected: "client-to-gateway" })).toBeNull();
    expect(projectElementResults({ ...fixture(), variantId: "absent" })).toBeNull();
    expect(projectElementResults({ ...fixture(), pointId: "absent" })).toBeNull();
    expect(projectElementResults({ ...fixture(), currentModel: structuredClone(model) })).toBeNull();
    expect(Object.values(values({ ...fixture(), window: 99 })).every(metric => metric.value === null)).toBe(true);
  });
  it("keeps empty latency and zero denominators unavailable", () => {
    const context = fixture();
    Object.assign(context.summary.variants[0].points[0].aggregate.services.gateway.totals,
      { offeredAttempts: 0,
      measurementMs: 0,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: 0, waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } });
    context.nodes = [{ id: "gateway", windows: [window(100, 10, null)], latency: [{ count: 0, sumMs: 0 }] }];
    const result = values(context);
    for (const key of ["utilization", "meanQueue", "queueRejectionRate", "admittedAttemptsPerSecond", "meanLatencyMs"]) {
      expect(result[key].value).toBeNull();
    }
  });
  it("excludes the indivisible window crossing warmup and exposes the actual covered range", () => {
    const context = fixture();
    context.manifest.series!.warmupMs = 150;
    const result = projectElementResults(context)!;
    expect(result.values.meanLatencyMs.value).toBeCloseTo(490 / 11);
    expect(result.latencyCoverage).toEqual({ fromMs: 200, toMs: 1175 });
  });
});
