import { describe, expect, it } from "vitest";
import type { OutputCalculation, TypeDescriptor } from "../api/apiTypes";
import { localizeCatalog } from "../i18n/catalog";
import { catalog, model } from "../test/fixtures";
import { calculateOutput, inspectorOutputs, outputValue, outputWindow, outputsOf, overlayOutputs, selectedOverlayOutput, timelineGroups } from "./outputs";
import { decodeSeriesPart } from "./series/decode";
import golden from "./series/fixtures/retry-storm-baseline-rep-0.json";

describe("catalog output contract", () => {
  it("shares a metric selector across resource-specific labels and help", () => {
    const service = catalog.types.find(type => type.id === "service")!;
    const utilization = service.outputs.find(output => output.id === "utilization")!;
    const database: TypeDescriptor = { ...service, id: "database", outputs: [{ ...utilization,
      overlay: { ...utilization.overlay!, label: "Connections busy {value}", description: "Busy connection time." },
    }] };
    const choices = overlayOutputs({ ...catalog, types: [service, database] }, "BLOCK");
    expect(choices.filter(choice => choice.id === "utilization").map(choice => [choice.key, choice.types]))
      .toEqual([["utilization", ["service", "database"]]]);
  });
  it("preserves existing Timeline groups and adds pool and policy outputs with their units", () => {
    expect(timelineGroups(catalog).map(group => [group.title, group.unit, group.scale, group.metrics.map(metric => metric.label)])).toEqual([
      ["Rates", "RPS", 1, ["Sent attempts", "Original requests", "Offered attempts", "Admitted attempts", "Successes", "Retries", "Successful requests with fallback", "Fallbacks"]],
      ["Latency", "ms", 1, ["Mean latency", "p50 latency", "p95 latency", "p99 latency"]],
      ["Errors and rejections", "RPS", 1, ["Failures", "Timeouts", "Orphaned attempts", "Queue rejections", "Circuit rejections", "Retries denied by budget"]],
      ["Utilization", "%", 100, ["Handler utilization"]],
      ["Call state", "requests", 1, ["Mean in-flight", "Mean orphaned work", "Mean backoff"]],
      ["Queue", "requests", 1, ["Mean queue"]],
      ["Pool utilization", "%", 100, ["Connection pool utilization"]],
      ["Connection pool", "requests", 1, ["Mean connection wait queue", "Connection acquisition timeouts"]],
      ["Service policies", "RPS", 1, ["Rate-limit rejections", "Failed health probes"]],
      ["Service policies", "%", 100, ["Rate-limited share"]],
      ["Circuit breaker", "%", 100, ["Circuit open share"]],
      ["Readiness", "%", 100, ["Not-ready share"]],
    ]);
  });

  it("computes service policy outputs from raw windows and pooled summary totals", () => {
    const outputs = outputsOf(catalog, "service");
    const frame = { startMs: 0, durationMs: 100, offeredAttempts: 20, rateLimited: 5, probeFailures: 2, notReadyMs: 25 };
    const expected = { rateLimitedPerSecond: 50, rateLimitedRate: 0.25, probeFailuresPerSecond: 20, notReadyShare: 0.25 };
    const totals = { measurementMs: 400, offeredAttempts: 80, rateLimited: 20, probeFailures: 8, notReadyMs: 100 };
    for (const [id, value] of Object.entries(expected)) {
      const output = outputs.find(output => output.id === id)!;
      expect(outputWindow([output], frame)[id]).toBe(value);
      expect(outputValue(output, { totals }, false).value).toBe(value);
    }
  });

  it("preserves inspector and overlay sets, labels and units", () => {
    expect(inspectorOutputs(outputsOf(catalog, "service")).map(output => [output.inspector!.title, output.unit])).toEqual([
      ["Handler utilization", "PERCENT"], ["Mean queue", "REQUESTS"], ["Queue fill", "PERCENT"],
      ["Queue rejection share", "PERCENT"], ["Admitted attempts", "PER_SECOND"], ["Mean latency", "MILLISECONDS"],
    ]);
    expect(inspectorOutputs(outputsOf(catalog, "call")).map(output => [output.inspector!.title, output.unit])).toEqual([
      ["Sent attempts", "PER_SECOND"], ["Retries", "PER_SECOND"], ["Timeout share", "PERCENT"],
      ["Orphaned attempts", "REQUESTS"], ["Mean orphaned work", "REQUESTS"], ["Mean in flight", "REQUESTS"],
      ["Mean backoff", "REQUESTS"], ["Mean call duration", "MILLISECONDS"], ["Attempts per request", "MULTIPLIER"],
      ["Connection pool utilization", "PERCENT"], ["Mean connection wait queue", "REQUESTS"], ["Connection acquisition timeouts", "REQUESTS"],
    ]);
    expect(overlayOutputs(catalog, "BLOCK").map(output => output.overlay!.title)).toEqual(["Utilization", "Mean queue", "Queue rejections"]);
    expect(overlayOutputs(catalog, "CONNECTION").map(output => output.overlay!.title)).toEqual(["Attempts per request", "Sent attempts", "Timeout share", "Orphaned work"]);
  });

  it("keeps different type-local outputs with the same id as separate overlay choices", () => {
    const service = catalog.types.find(type => type.id === "service")!;
    const pool: TypeDescriptor = { ...service, id: "pool", title: "Pool", outputs: [{
      ...service.outputs.find(output => output.id === "admittedAttemptsPerSecond")!, id: "meanQueue",
      overlay: { title: "Pool throughput", label: "Pool throughput {value}", description: "Pool throughput", order: 1 },
    }] };
    const choices = overlayOutputs({ ...catalog, types: [...catalog.types, pool] }, "BLOCK").filter(output => output.id === "meanQueue");
    expect(choices.map(output => output.overlay!.title)).toEqual(["Mean queue", "Pool throughput"]);
    expect(choices.map(output => output.unit)).toEqual(["REQUESTS", "PER_SECOND"]);
    expect(new Set(choices.map(output => output.key)).size).toBe(2);
    expect(selectedOverlayOutput(choices, choices[0].key)?.types).toEqual(["service"]);
    expect(selectedOverlayOutput(choices, choices[1].key)?.types).toEqual(["pool"]);
    expect(selectedOverlayOutput(choices, "meanQueue")?.types).toEqual(["service"]);
    const amplification = overlayOutputs(catalog, "CONNECTION").filter(output => output.id === "amplification");
    expect(amplification).toHaveLength(1);
    expect(amplification[0].key).toBe("amplification");
    expect(amplification[0].types).toEqual(["request", "call"]);
  });

  it("hides outputs of missing model types without changing the keys used by canvas renderers", () => {
    const service = catalog.types.find(type => type.id === "service")!;
    const pool: TypeDescriptor = { ...service, id: "pool", outputs: [{
      ...service.outputs.find(output => output.id === "admittedAttemptsPerSecond")!, id: "meanQueue",
      overlay: { title: "Pool throughput", label: "Pool throughput {value}", description: "Pool throughput", order: 1 },
    }] };
    const extended = { ...catalog, types: [...catalog.types, pool] };
    const all = overlayOutputs(extended, "BLOCK");
    const visible = overlayOutputs(extended, "BLOCK", model);
    expect(visible.map(output => output.overlay!.title)).toEqual(["Utilization", "Mean queue", "Queue rejections"]);
    expect(visible.find(output => output.id === "meanQueue")!.key).toBe(all.find(output => output.types.includes("service") && output.id === "meanQueue")!.key);
    expect(overlayOutputs(extended, "CONNECTION", { ...model, connections: [] })).toEqual([]);
  });

  it("matches the existing retry-storm node values and core quantile bits in every window", () => {
    const decoded = decodeSeriesPart(JSON.stringify(golden.part));
    const expectedQuantiles = new Map(golden.quantiles.map(value => [`${value.node}/${value.window}`, value]));
    const bits = (value: number | null) => {
      if (value === null) return null;
      const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, value);
      return bytes.getUint32(0).toString(16).padStart(8, "0") + bytes.getUint32(4).toString(16).padStart(8, "0");
    };
    for (const node of decoded.nodes) for (const [index, frame] of node.windows.entries()) {
      const raw = golden.part.nodes.find(candidate => candidate.id === node.id)!.windows[index] as import("../api/apiTypes").WindowMetrics;
      const type = Object.keys(raw.slotPools).length === 0 ? "client" : "service";
      const values = outputWindow(outputsOf(catalog, type), { ...frame.metrics, params: { queue: 16 } });
      const counts = type === "client" ? ["originalArrivals", "successes", "failures"] as const
        : ["offeredAttempts", "admittedAttempts", "successes", "retries", "failures", "timeouts"] as const;
      for (const field of counts) expect(values[`${field}PerSecond`]).toBe(raw[field] * 1000 / raw.durationMs);
      expect(values.meanLatencyMs).toBe(raw.latency.count === 0 ? null : raw.latency.sumMs / raw.latency.count);
      const quantiles = expectedQuantiles.get(`${node.id}/${index}`)!;
      expect([bits(values.p50LatencyMs), bits(values.p95LatencyMs), bits(values.p99LatencyMs)])
        .toEqual([quantiles.p50 ?? null, quantiles.p95 ?? null, quantiles.p99 ?? null]);
      if (type === "service") {
        expect(values.queueRejectionsPerSecond).toBe(raw.slotPools.handlers.queueFullCount * 1000 / raw.durationMs);
        expect(values.utilization).toBe(raw.slotPools.handlers.busyIntegralMs / raw.slotPools.handlers.capacityIntegralMs);
        expect(values.meanQueue).toBe(raw.slotPools.handlers.queueIntegralMs / raw.durationMs);
        expect(values.queueFill).toBeCloseTo(raw.slotPools.handlers.queueIntegralMs / raw.durationMs / 16, 14);
        const rejection = raw.offeredAttempts === 0 ? null : raw.slotPools.handlers.queueFullCount / raw.offeredAttempts;
        expect(values.queueRejectionRate).toBe(rejection);
      }
    }
  });

  it("matches every retry-storm call output using its own raw window and target arrivals", () => {
    const decoded = decodeSeriesPart(JSON.stringify(golden.part));
    for (const connection of decoded.connections) for (const [index, frame] of connection.windows.entries()) {
      const raw = golden.part.connections.find(candidate => candidate.id === connection.id)!.windows[index];
      const target = decoded.nodes.find(node => node.id === (connection.id === "gateway-to-middle" ? "middle" : "dependency"))!.windows[index].metrics;
      const values = outputWindow(outputsOf(catalog, "call"), { ...frame, target, entries: target.entries });
      expect(values.sentAttemptsPerSecond).toBe(raw.sentAttempts * 1000 / raw.durationMs);
      expect(values.retriesPerSecond).toBe(raw.retries * 1000 / raw.durationMs);
      expect(values.successesPerSecond).toBe(raw.succeeded * 1000 / raw.durationMs);
      expect(values.failuresPerSecond).toBe(raw.failed * 1000 / raw.durationMs);
      expect(values.timeoutsPerSecond).toBe(raw.timeouts * 1000 / raw.durationMs);
      expect(values.orphanedPerSecond).toBe(raw.orphaned * 1000 / raw.durationMs);
      expect(values.orphaned).toBe(raw.orphaned);
      expect(values.meanInFlight).toBe(raw.inFlightIntegralMs / raw.durationMs);
      expect(values.meanOrphaned).toBe(raw.orphanedIntegralMs / raw.durationMs);
      expect(values.meanBackoff).toBe(raw.backoffIntegralMs / raw.durationMs);
      expect(values.timeoutRate).toBe(raw.sentAttempts === 0 ? null : raw.timeouts / raw.sentAttempts);
      expect(values.meanLatencyMs).toBe(raw.latency.count === 0 ? null : raw.latency.sumMs / raw.latency.count);
      expect([values.p50LatencyMs, values.p95LatencyMs, values.p99LatencyMs]).toEqual([frame.latency.p50Ms, frame.latency.p95Ms, frame.latency.p99Ms]);
      expect(values.amplification).toBe(target.entries.total.originalArrivals === 0 ? null : target.admittedAttempts / target.entries.total.originalArrivals);
    }
  });

  it.each([
    [{ kind: "VALUE", field: "missing" }, {}, null],
    [{ kind: "RATIO", field: "count", divisor: "durationMs" }, { count: 0, durationMs: 0 }, null],
    [{ kind: "NORMALIZED_RATIO", field: "busy", divisor: "durationMs", capacity: "handlers" }, { busy: 1, durationMs: 1, handlers: 0 }, null],
    [{ kind: "MEAN", field: "latency" }, { latency: { count: 0, sumMs: 0 } }, null],
    [{ kind: "VALUE", field: "value" }, { value: Infinity }, null],
    [{ kind: "VALUE", field: "value" }, Object.create({ value: 12 }), null],
    [{ kind: "RATE", field: "count", divisor: "durationMs" }, { count: 2, durationMs: 25 }, 80],
    [{ kind: "RATIO", field: "count", divisor: "params.capacity" }, { count: 2, params: { capacity: 4 } }, 0.5],
  ] as [OutputCalculation, unknown, number | null][])("keeps unavailable inputs distinct from zero: %j", (calculation, context, expected) => {
    expect(calculateOutput(calculation, context)).toBe(expected);
  });

  it("uses the supplied replication mean and preserves confidence bounds outside the physical range", () => {
    const output = outputsOf(catalog, "call").find(output => output.id === "timeoutRate")!;
    expect(outputValue(output, { timeoutRate: { count: 2, mean: 0.25, stdDev: 0.2, ci95Low: -0.1, ci95High: 1.2 }, totals: { timeouts: 0, sentAttempts: 100 } }, false))
      .toEqual({ value: 0.25, source: "replications", count: 2, stdDev: 0.2, ci95Low: -0.1, ci95High: 1.2 });
    expect(outputValue(output, { timeouts: 0, sentAttempts: 100 }, true)).toEqual({ value: 0, source: "window" });
  });

  it("localizes outputs without changing calculations or mutating the API catalog", () => {
    const localized = localizeCatalog(catalog, "ru");
    const original = outputsOf(catalog, "service")[0], translated = outputsOf(localized, "service")[0];
    expect(translated.title).not.toBe(original.title);
    expect(translated.calculation).toEqual(original.calculation);
    expect(original.title).toBe("Offered attempts");
  });
});

describe("replica group output bindings", () => {
  it.each(["service", "call"])("reads %s group extrema and pooled p99 with the closed operations", (type) => {
    const outputs = outputsOf(catalog, type);
    const set = type === "service" ? "handlers" : "pool";
    const metrics = { busyIntegralMs: 18, capacityIntegralMs: 30, queueIntegralMs: 30,
      waitCount: 2, totalWaitMs: 4, queueFullCount: 0, waitLimitCount: 1,
      replicaExtrema: { minUtilization: 0.2, maxUtilization: 1, maxUtilizationReplica: 2,
        minMeanQueueLength: 0, maxMeanQueueLength: 3, maxMeanQueueLengthReplica: 2 } };
    const context = { durationMs: 10, slotPools: { [set]: metrics } };
    const maximum = outputs.find(output => output.id === "maxReplicaUtilization");
    expect(maximum).toBeDefined();
    expect(calculateOutput(maximum!.calculation, context)).toBe(1);
    expect(calculateOutput(outputs.find(output => output.id === "maxReplicaMeanQueue")!.calculation, context)).toBe(3);
    expect(calculateOutput(outputs.find(output => output.id === "groupUtilization")!.calculation, context)).toBe(0.6);
    expect(outputValue(outputs.find(output => output.id === "groupP99LatencyMs")!, {
      pooledLatency: { p99Ms: 19.8 },
    }, false)).toEqual({ value: 19.8, source: "pooled" });
    const group = outputs.filter(output => ["maxReplicaUtilization", "groupUtilization", "groupP99LatencyMs"].includes(output.id));
    expect(group.every(output => output.timeline == null && output.inspector == null && output.overlay == null)).toBe(true);
  });
  it("retains group replication counts and unmodified confidence intervals", () => {
    const output = outputsOf(catalog, "service").find(output => output.id === "groupUtilization");
    expect(output).toBeDefined();
    expect(outputValue(output!, { slotPoolSummaries: { handlers: { utilization: {
      count: 2, mean: 0.6, stdDev: 0.2, ci95Low: -0.1, ci95High: 1.3, min: 0.4, max: 0.8,
    } } } }, false)).toEqual({ value: 0.6, source: "replications", count: 2, stdDev: 0.2, ci95Low: -0.1, ci95High: 1.3 });
  });
});
