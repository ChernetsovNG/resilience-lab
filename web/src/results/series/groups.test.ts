import { describe, expect, it } from "vitest";
import type { SeriesIndex } from "../../api/apiTypes";
import { decodeSeriesPart } from "./decode";
import { SeriesLoader, type SeriesApi } from "./loader";

const extrema = {
  minUtilization: 0.2, maxUtilization: 1, maxUtilizationReplica: 2,
  minMeanQueueLength: 0, maxMeanQueueLength: 3, maxMeanQueueLengthReplica: 2,
};
function groupPart() {
  return {
    schemaVersion: 6, kind: "GROUP", profile: "ddsketch-bitwise6-rational-v1",
    fromWindow: 0, untilWindow: 1, nodes: [],
    connections: [{ id: "worker-to-db", windows: [{
      startMs: 0, durationMs: 10, sentAttempts: 5, retries: 1, succeeded: 2,
      failed: 1, timeouts: 2, orphaned: 1, inFlightIntegralMs: 24,
      orphanedIntegralMs: 4, backoffIntegralMs: 3,
      latency: { count: 3, sumMs: 3, sketch: [1, 0, 1, 64, 1] },
      slotPools: { pool: { busyIntegralMs: 18, queueIntegralMs: 30, capacityIntegralMs: 30,
        waitCount: 2, totalWaitMs: 4, queueFullCount: 0, waitLimitCount: 1,
        replicaExtrema: extrema } },
    }] }],
  };
}

describe("replica group series", () => {
  it("preserves pooled statistics and replica extrema when decoding a group part", () => {
    const decoded = decodeSeriesPart(JSON.stringify(groupPart()));
    expect(decoded.connections[0].windows[0]).toMatchObject({
      sentAttempts: 5, durationMs: 10,
      latency: { count: 3, sumMs: 3, meanMs: 1, p99Ms: 2.015625 },
      slotPools: { pool: { busyIntegralMs: 18, capacityIntegralMs: 30, replicaExtrema: extrema } },
    });
  });
  it("loads a copied-call group without downloading instance parts", async () => {
    const group = groupPart();
    const instance = { ...group, kind: "INSTANCE", connections: group.connections.map(row => ({ ...row, id: "worker-to-db#1" })) };
    const texts = [JSON.stringify(instance), JSON.stringify(group)];
    const index = {
      schemaVersion: 6, endMs: 10, windowMs: 10,
      groups: [{ id: "worker-to-db", kind: "CONNECTION", instances: [
        { id: "worker-to-db#1", replica: 1 }, { id: "worker-to-db#2", replica: 2 }, { id: "worker-to-db#3", replica: 3 },
      ] }],
      parts: [instance, group].map((part, number) => ({
        file: `part-${number}.json.gz`, kind: part.kind, nodes: [],
        connections: part.connections.map(row => row.id), fromWindow: 0, untilWindow: 1,
        uncompressedBytes: texts[number].length, sha256: String(number).repeat(64),
      })),
    } as SeriesIndex;
    const downloaded: number[] = [];
    const api: SeriesApi = {
      seriesIndex: async () => index,
      seriesPart: async (_run, _variant, _cell, _rep, number) => {
        downloaded.push(number);
        return { text: texts[number], etag: `"${index.parts[number].sha256}"` };
      },
    };
    const loader = new SeriesLoader({ api, decoderFactory: () => ({
      decode: async texts => texts.map(decodeSeriesPart), close: () => undefined,
    }) });
    const result = await loader.loadConnections({
      runId: "run", variant: "baseline", cell: "p0", replication: 0,
      connections: ["worker-to-db"], fromWindow: 0, untilWindow: 1,
    });
    expect(result[0].windows[0]).toMatchObject({ sentAttempts: 5, slotPools: { pool: { replicaExtrema: extrema } } });
    expect(downloaded).toEqual([1]);
  });
  it("rejects the previous schema instead of interpreting it as the new format", () => {
    expect(() => decodeSeriesPart(JSON.stringify({ ...groupPart(), schemaVersion: 5 }))).toThrow(/schema version/i);
  });
});

it.each([false, true])("loads a service group and shared client context without extra instance parts (selected replica: %s)", async (withReplica) => {
  const window = { startMs: 0, durationMs: 10, originalArrivals: 0, offeredAttempts: 15,
    admittedAttempts: 14, successes: 12, failures: 2, timeouts: 0, retries: 1,
    latency: { count: 3, sumMs: 3, sketch: [1, 0, 1, 64, 1] },
    slotPools: { handlers: { busyIntegralMs: 18, queueIntegralMs: 30, capacityIntegralMs: 30,
      waitCount: 2, totalWaitMs: 4, queueFullCount: 0, waitLimitCount: 1, replicaExtrema: extrema } } };
  const group = { schemaVersion: 6, kind: "GROUP", profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 1,
    nodes: [{ id: "workers", windows: [{ ...window, clientOriginalArrivals: 7 }] }], connections: [] };
  const instance = { ...group, kind: "INSTANCE", nodes: [{ id: "workers#1", windows: [window] }] };
  const client = { ...group, kind: "INSTANCE", nodes: [{ id: "client", windows: [{ ...window, originalArrivals: 7, slotPools: {} }] }] };
  const parts = [instance, group, client];
  const texts = parts.map(part => JSON.stringify(part));
  const index = { schemaVersion: 6, endMs: 10, windowMs: 10,
    groups: [{ id: "workers", kind: "NODE", instances: [1, 2, 3].map(replica => ({ id: `workers#${replica}`, replica })) }],
    parts: parts.map((part, number) => ({ file: `part-${number}.json.gz`, kind: part.kind,
      nodes: part.nodes.map(node => node.id), connections: [], fromWindow: 0, untilWindow: 1,
      uncompressedBytes: texts[number].length, sha256: String(number).repeat(64) })),
  } as SeriesIndex;
  const downloaded: number[] = [];
  const loader = new SeriesLoader({ api: {
    seriesIndex: async () => index,
    seriesPart: async (_run, _variant, _cell, _rep, number) => {
      downloaded.push(number);
      return { text: texts[number], etag: `"${index.parts[number].sha256}"` };
    },
  }, decoderFactory: () => ({ decode: async texts => texts.map(decodeSeriesPart), close: () => undefined }) });
  const result = await loader.load({ runId: "run", variant: "baseline", cell: "p0", replication: 0,
    nodes: withReplica ? ["workers", "workers#1"] : ["workers"], fromWindow: 0, untilWindow: 1 });
  for (const node of result) expect(node.windows[0].client).toEqual({ originalArrivals: 7 });
  expect(downloaded).toEqual(withReplica ? [0, 1] : [1]);
});
