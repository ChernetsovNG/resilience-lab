import { describe, expect, it } from "vitest";
import { decodeSeriesPart } from "./decode";
import { SeriesLoader } from "./loader";
import type { SeriesIndex } from "../../api/apiTypes";

const entryWindow = (originalArrivals: number) => ({
  startMs: 0, durationMs: 10, originalArrivals, clientOriginalArrivals: 10, offeredAttempts: 0, admittedAttempts: 0,
  successes: originalArrivals - 1, failures: 1, failuresByReason: { deadline: 1 },
  degraded: 0, timeouts: 0, retries: 0, rateLimited: 0, probes: 0, probeFailures: 0,
  notReadyMs: 0, ejections: 0, ejectedMs: 0,
  latency: { count: 0, sumMs: 0, sketch: [0] }, slotPools: {},
});
const part = {
  schemaVersion: 7, kind: "INSTANCE", profile: "ddsketch-bitwise6-rational-v1",
  fromWindow: 0, untilWindow: 1,
  nodes: [
    { id: "mobile-app", windows: [entryWindow(3)] },
    { id: "partner-api", windows: [entryWindow(7)] },
    { id: "checkout", windows: [{ ...entryWindow(0), originalArrivals: 0, admittedAttempts: 15,
      successes: 12, failures: 3, failuresByReason: { queueFull: 2, timeout: 1 },
      slotPools: { handlers: { busyIntegralMs: 8, queueIntegralMs: 4, capacityIntegralMs: 10,
        waitCount: 0, totalWaitMs: 0, queueFullCount: 2, waitLimitCount: 0 } } }] },
  ],
  classes: [{ id: "status", windows: [entryWindow(4)] }, { id: "purchase", windows: [entryWindow(6)] }],
  connections: [{ id: "checkout-to-worker", windows: [{
    startMs: 0, durationMs: 10, clientOriginalArrivals: 10, sentAttempts: 3, retries: 1, succeeded: 1, failed: 2,
    failuresByReason: { error: 1, waitLimit: 1 }, timeouts: 0, orphaned: 0,
    inFlightIntegralMs: 5, orphanedIntegralMs: 0, backoffIntegralMs: 0,
    circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
    latency: { count: 0, sumMs: 0, sketch: [0] }, slotPools: {},
  }] }],
};

describe("entry series", () => {
  it("loads request types independently of identically named nodes, reusing mixed-part cache", async () => {
    const data = [
      { ...part, nodes: [{ id: "status", windows: [entryWindow(9)] }], classes: part.classes, connections: [] },
      { ...part, nodes: [], classes: [{ id: "status", windows: [{ ...entryWindow(2), startMs: 10, durationMs: 5 }] }], connections: [], fromWindow: 1, untilWindow: 2 },
    ];
    const texts = data.map(value => JSON.stringify(value));
    const index = { schemaVersion: 7, endMs: 15, windowMs: 10, groups: [], parts: data.map((value, number) => ({
      file: `part-${number}.json.gz`, kind: "INSTANCE", nodes: value.nodes.map(node => node.id),
      classes: value.classes.map(row => row.id), connections: [], fromWindow: value.fromWindow, untilWindow: value.untilWindow,
      uncompressedBytes: texts[number].length, sha256: String(number).repeat(64),
    })) } as SeriesIndex;
    const downloaded: number[] = [];
    const loader = new SeriesLoader({ api: { seriesIndex: async () => index,
      seriesPart: async (_run, _variant, _cell, _replication, number) => {
        downloaded.push(number);
        return { text: texts[number], etag: `"${index.parts[number].sha256}"` };
      },
    }, decoderFactory: () => ({ decode: async values => values.map(decodeSeriesPart), close: () => undefined }) });
    const request = { runId: "run", variant: "baseline", cell: "p0", replication: 0, fromWindow: 0, untilWindow: 2 };
    const [node] = await loader.load({ ...request, nodes: ["status"], untilWindow: 1 });
    expect(node.windows[0].originalArrivals).toBe(9);
    const [requestType] = await loader.loadClasses({ ...request, classes: ["status"] });
    expect(requestType.windows.map(window => [window.startMs, window.durationMs, window.originalArrivals])).toEqual([[0, 10, 4], [10, 5, 2]]);
    expect(downloaded).toEqual([0, 1]);
    expect((await loader.loadClasses({ ...request, classes: ["status"], fromWindow: 1 }))[0].windows[0].originalArrivals).toBe(2);
    expect(await loader.loadClasses({ ...request, classes: ["missing"] })).toEqual([]);
    expect(downloaded).toEqual([0, 1]);
  });

  it("keeps actual client IDs, class windows, failure reasons and zero policy fields", () => {
    const decoded = decodeSeriesPart(JSON.stringify(part));
    expect(decoded.nodes.map(node => node.id)).toEqual(["mobile-app", "partner-api", "checkout"]);
    expect(decoded.classes.map(row => [row.id, row.windows[0].originalArrivals])).toEqual([["status", 4], ["purchase", 6]]);
    expect(decoded.classes[0].windows[0].metrics).toMatchObject({ failuresByReason: { deadline: 1 }, degraded: 0 });
    expect(decoded.nodes[2].windows[0].metrics).toMatchObject({
      failuresByReason: { queueFull: 2, timeout: 1 }, rateLimited: 0, probes: 0,
      probeFailures: 0, notReadyMs: 0, ejections: 0, ejectedMs: 0,
    });
    expect(decoded.connections[0].windows[0]).toMatchObject({
      failuresByReason: { error: 1, waitLimit: 1 }, clientOriginalArrivals: 10, circuitOpenMs: 0,
      circuitRejections: 0, retriesDenied: 0, fallbacks: 0,
    });
    expect(decoded.nodes[2].windows[0].metrics.entries.total.originalArrivals).toBe(10);
  });

  it.each([false, true])("loads only the selected replica with two clients in separate parts (reverse parts: %s)", async reverse => {
    const [mobile, partner, service] = part.nodes;
    const parts = [
      { ...part, nodes: [service], classes: [], connections: [] },
      { ...part, nodes: [mobile], classes: part.classes, connections: [] },
      { ...part, nodes: [partner], classes: [], connections: [] },
    ];
    if (reverse) parts.reverse();
    const selectedId = "checkout#2";
    parts.find(value => value.nodes.includes(service))!.nodes = [{ ...service, id: selectedId }];
    const texts = parts.map(value => JSON.stringify(value));
    const index = { schemaVersion: 7, endMs: 10, windowMs: 10, groups: [], parts: parts.map((value, number) => ({
      file: `part-${number}.json.gz`, kind: "INSTANCE", nodes: value.nodes.map(node => node.id),
      classes: value.classes.map(row => row.id), connections: [], fromWindow: 0, untilWindow: 1,
      uncompressedBytes: texts[number].length, sha256: String(number).repeat(64),
    })) } as SeriesIndex;
    const downloaded: number[] = [];
    const loader = new SeriesLoader({ api: { seriesIndex: async () => index,
      seriesPart: async (_run, _variant, _cell, _replication, number) => {
        downloaded.push(number);
        return { text: texts[number], etag: `"${index.parts[number].sha256}"` };
      },
    }, decoderFactory: () => ({ decode: async values => values.map(decodeSeriesPart), close: () => undefined }) });
    const [result] = await loader.load({ runId: "run", variant: "baseline", cell: "p0", replication: 0,
      nodes: [selectedId], fromWindow: 0, untilWindow: 1 });
    expect(downloaded).toEqual([index.parts.findIndex(reference => reference.nodes.includes(selectedId))]);
    expect(result.windows[0].entries.total.originalArrivals).toBe(10);
    expect(result.windows[0].admittedAttempts / result.windows[0].entries.total.originalArrivals).toBe(1.5);
  });
});
