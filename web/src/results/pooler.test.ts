import { describe, expect, it } from "vitest";
import type { Catalog, ModelFile } from "../api/apiTypes";
import fullCatalog from "../test/catalog.json";
import { experiment, layout, manifest, model, summary } from "../test/fixtures";
import { documentDrafts, setModelParam } from "../workspace/editor";
import { connectionRule } from "../workspace/structure";
import { projectElementResults } from "../inspector/elementResultsData";
import { canvasResults } from "./canvasResults";
import { decodeSeriesPart } from "./series/decode";

const catalog = fullCatalog as Catalog;
function poolerModel(): ModelFile {
  return { ...model, blocks: { ...model.blocks, pooler: { type: "pooler", params: {
    maxClientConnections: 12, poolSize: 3, waitTimeout: "25ms", processing: { kind: "fixed", mean: "1ms" },
  } } } };
}
function poolerSummary() {
  const result = structuredClone(summary);
  result.variants[0].points[0].aggregate.poolers = { pooler: {
    totals: { offeredAttempts: 10,
      admittedAttempts: 8,
      successes: 7,
      failures: 1,
      measurementMs: 100,
      slotPools: { clientConnections: { busyIntegralMs: 300, queueIntegralMs: 0, capacityIntegralMs: 1200, waitCount: 0, totalWaitMs: 0, queueFullCount: 2, waitLimitCount: 0 }, serverConnections: { busyIntegralMs: 150, queueIntegralMs: 50, capacityIntegralMs: 300, waitCount: 5, totalWaitMs: 25, queueFullCount: 0, waitLimitCount: 1 } } },
    pooledLatency: { meanMs: 12, p95Ms: 20, p99Ms: 25, statistics: { count: 8, sumMs: 96, sketch: [8] } },
  } };
  return result;
}

describe("transaction pooler integration", () => {
  it("permits calls from both service and pooler using catalog source types", () => {
    const source = poolerModel();
    expect(connectionRule(catalog, source, "gateway", "pooler", "out", "in").type).toBe("call");
    expect(connectionRule(catalog, source, "pooler", "dependency", "out", "in").type).toBe("call");
    expect(connectionRule(catalog, source, "client", "pooler", "out", "in").type).toBeNull();
  });

  it("preserves every pooler parameter when another element is edited and saved", () => {
    const source = poolerModel();
    const documents = setModelParam("gateway", "handlers", 8)({ model: source, layout, experiment });
    expect(documentDrafts({ ...documents, experimentPath: "e.experiment.json", modelPath: "m.model.json", layoutPath: "l.layout.json",
      versions: { experiment: "e", model: "m", layout: "l" }, saved: { model: source, layout, experiment } })[0].content.model?.blocks.pooler)
      .toEqual(source.blocks.pooler);
  });

  it("shows pooler summary resources and rejection reasons in the inspector and canvas", () => {
    const source = poolerModel();
    const run = poolerSummary();
    const result = projectElementResults({ summary: run, manifest, runModel: source, currentModel: source, experiment, catalog,
      variantId: "baseline", pointId: "p0", replication: 0, window: null, selected: "pooler" });
    expect(result?.values.serverUtilization.value).toBe(0.5);
    expect(result?.values.clientUtilization.value).toBe(0.25);
    expect(result?.values.meanWaitingClients.value).toBe(0.5);
    expect(result?.values.clientConnectionRejections.value).toBe(1);
    expect(result?.values.waitTimeouts.value).toBe(0.5);
    expect(result?.values.meanServerWaitMs.value).toBe(5);
    expect(result?.values.meanLatencyMs.value).toBe(12);
    expect(canvasResults(run, source, "baseline", "p0", catalog)?.services.get("pooler")?.values.serverUtilization).toBe(0.5);
  });

  it("decodes pooler resource fields from the current series format", () => {
    const part = { schemaVersion: 5, profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 1, connections: [],
      nodes: [{ id: "pooler", windows: [{ startMs: 0,
      durationMs: 10,
      originalArrivals: 0,
      offeredAttempts: 3,
      admittedAttempts: 2,
      successes: 1,
      failures: 1,
      timeouts: 0,
      retries: 0,
      latency: { count: 2, sumMs: 15, sketch: [2] },
      slotPools: { clientConnections: { busyIntegralMs: 15, queueIntegralMs: 0, capacityIntegralMs: (2) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 1, waitLimitCount: 0 }, serverConnections: { busyIntegralMs: 10, queueIntegralMs: 5, capacityIntegralMs: (1) * (10), waitCount: 1, totalWaitMs: 5, queueFullCount: 0, waitLimitCount: 1 } } }] }] };
    expect(decodeSeriesPart(JSON.stringify(part)).nodes[0].windows[0].metrics.slotPools.serverConnections?.totalWaitMs).toBe(5);
    expect(() => decodeSeriesPart(JSON.stringify({ ...part, schemaVersion: 2 }))).toThrow(/schema/i);
  });
});
