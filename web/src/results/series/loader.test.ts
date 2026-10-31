import { calculateOutput, outputsOf } from "../outputs";
import { catalog } from "../../test/fixtures";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/apiClient";
import type { ConnectionWindowMetrics, SeriesIndex, SeriesPart, WindowMetrics } from "../../api/apiTypes";
import { SeriesPartCache } from "./cache";
import { decodeSeriesPart } from "./decode";
import { SeriesLoadError, SeriesLoader, type SeriesApi, type SeriesDecoderFactory } from "./loader";

const CLIENT_SHA = "a".repeat(64);
const SERVICE_SHA = "b".repeat(64);

function window(values: Partial<WindowMetrics> = {}): WindowMetrics {
  return { startMs: 0,
      durationMs: 10,
      originalArrivals: 0,
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

function part(nodes: SeriesPart["nodes"], fromWindow = 0, untilWindow = fromWindow + 2): SeriesPart {
  return { schemaVersion: 7, kind: "INSTANCE", profile: "ddsketch-bitwise6-rational-v1", fromWindow, untilWindow, nodes, classes: [], connections: [] };
}

function fixture() {
  const client = part([{ id: "client", windows: [
    window({ originalArrivals: 10 }),
    window({ startMs: 10, originalArrivals: 20 }),
  ] }]);
  const service = part([{ id: "service", windows: [
    window({ admittedAttempts: 15,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (2) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }),
    window({ startMs: 10,
      admittedAttempts: 40,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (2) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }),
  ] }]);
  const texts = [JSON.stringify(client), JSON.stringify(service)];
  const index: SeriesIndex = { groups: [],
    schemaVersion: 7,
    endMs: 20,
    windowMs: 10,
    parts: [
      { kind: "INSTANCE", file: "part-0.json.gz", nodes: ["client"], classes: [], connections: [], fromWindow: 0, untilWindow: 2, uncompressedBytes: texts[0].length, sha256: CLIENT_SHA },
      { kind: "INSTANCE", file: "part-1.json.gz", nodes: ["service"], classes: [], connections: [], fromWindow: 0, untilWindow: 2, uncompressedBytes: texts[1].length, sha256: SERVICE_SHA },
    ],
  };
  return { index, texts };
}

function apiFor(index: SeriesIndex, texts: string[], etags = index.parts.map((part) => `"${part.sha256}"`)) {
  return {
    seriesIndex: vi.fn(async () => index),
    seriesPart: vi.fn(async (_run: string, _variant: string, _cell: string, _replication: number, partNumber: number) => ({
      text: texts[partNumber],
      etag: etags[partNumber],
    })),
  } satisfies SeriesApi;
}

function decoderFactory(): SeriesDecoderFactory {
  return () => ({
    decode: async (texts: string[]) => texts.map(decodeSeriesPart),
    close: () => undefined,
  });
}

function request(nodes: string[], signal?: AbortSignal) {
  return { runId: "run", variant: "baseline", cell: "p0", replication: 0, nodes, fromWindow: 0, untilWindow: 2, signal };
}

describe("series loader", () => {
  it("returns each connection's own windows from connection-only and mixed parts", async () => {
    const callWindow = (startMs: number, sentAttempts: number): ConnectionWindowMetrics => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: startMs === 20 ? 5 : 10,
      sentAttempts,
      retries: 1,
      succeeded: 1,
      failed: 0,
      timeouts: 2,
      orphaned: 1,
      inFlightIntegralMs: 5,
      orphanedIntegralMs: 3,
      backoffIntegralMs: 2,
      latency: { count: 1, sumMs: 2, sketch: [0, 64, 1] },
      slotPools: {  } });
    const mixed = part([{ id: "client", windows: [window({ originalArrivals: 999 }), window({ startMs: 10 })] }]);
    mixed.connections = [{ id: "first-call", windows: [callWindow(0, 11), callWindow(10, 12)] }];
    const connectionOnly = part([]);
    connectionOnly.connections = [{ id: "second-call", windows: [callWindow(0, 21), callWindow(10, 22)] }];
    const last = part([], 2, 3);
    last.connections = [{ id: "first-call", windows: [callWindow(20, 13)] }];
    const unrelated = part([]);
    unrelated.connections = [{ id: "unselected-call", windows: [callWindow(0, 31), callWindow(10, 32)] }];
    const parts = [mixed, connectionOnly, last, unrelated];
    const texts = parts.map((value) => JSON.stringify(value));
    const index: SeriesIndex = { groups: [], schemaVersion: 7, endMs: 25, windowMs: 10, parts: parts.map((value, index) => ({
      classes: [],
      kind: "INSTANCE", file: `part-${index}.json.gz`, nodes: value.nodes.map((node) => node.id),
      connections: value.connections.map((connection) => connection.id), fromWindow: value.fromWindow,
      untilWindow: value.untilWindow, uncompressedBytes: texts[index].length, sha256: String(index).repeat(64),
    })) };
    const api = apiFor(index, texts);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    const result = await loader.loadConnections({ ...request([]), connections: ["first-call", "second-call"], fromWindow: 1, untilWindow: 3 });

    expect(result.map((connection) => [connection.id, connection.windows.map((value) => value.sentAttempts)])).toEqual([
      ["first-call", [12, 13]], ["second-call", [22]],
    ]);
    expect(result[0].windows[1]).toMatchObject({ startMs: 20, durationMs: 5, timeouts: 2, latency: { count: 1, sumMs: 2, meanMs: 2 } });
    expect(api.seriesPart.mock.calls.map((call) => call[4])).toEqual([0, 1, 2]);
  });

  it("does not download a part for an empty connection window range", async () => {
    const { index, texts } = fixture();
    const withConnection = { ...index, parts: index.parts.map((value) => ({ ...value, connections: ["call"] })) };
    const api = apiFor(withConnection, texts);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    expect(await loader.loadConnections({ ...request([]), connections: ["call"], fromWindow: 1, untilWindow: 1 })).toEqual([]);
    expect(api.seriesPart).not.toHaveBeenCalled();
  });

  it("reuses a mixed decoded part between node and connection selections", async () => {
    const { index } = fixture();
    const mixed = part([{ id: "client", windows: [window({ originalArrivals: 7 }), window({ startMs: 10 })] }]);
    mixed.connections = [{ id: "call", windows: [0, 10].map((startMs) => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: 10,
      sentAttempts: 3,
      retries: 1,
      succeeded: 1,
      failed: 0,
      timeouts: 1,
      orphaned: 1,
      inFlightIntegralMs: 5,
      orphanedIntegralMs: 3,
      backoffIntegralMs: 2,
      latency: { count: 1, sumMs: 2, sketch: [0, 64, 1] },
      slotPools: {  } })) }];
    const text = JSON.stringify(mixed);
    const api = apiFor({ ...index, parts: [{ ...index.parts[0], connections: ["call"], uncompressedBytes: text.length }] }, [text]);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    const nodes = await loader.load(request(["client"]));
    const connections = await loader.loadConnections({ ...request([]), connections: ["call"] });

    expect(nodes[0].windows[0].originalArrivals).toBe(7);
    expect(connections[0].windows[0].sentAttempts).toBe(3);
    expect(api.seriesPart).toHaveBeenCalledTimes(1);
  });

  it("shares a concurrent mixed-part download while allowing either consumer to abort", async () => {
    const { index } = fixture();
    const mixed = part([{ id: "client", windows: [window({ originalArrivals: 7 }), window({ startMs: 10 })] }]);
    mixed.connections = [{ id: "call", windows: [0, 10].map((startMs) => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: 10,
      sentAttempts: 3,
      retries: 1,
      succeeded: 1,
      failed: 0,
      timeouts: 1,
      orphaned: 1,
      inFlightIntegralMs: 5,
      orphanedIntegralMs: 3,
      backoffIntegralMs: 2,
      latency: { count: 1, sumMs: 2, sketch: [0, 64, 1] },
      slotPools: {  } })) }];
    const text = JSON.stringify(mixed);
    const api = apiFor({ ...index, parts: [{ ...index.parts[0], connections: ["call"], uncompressedBytes: text.length }] }, [text]);
    let resolvePart: ((value: { text: string; etag: string }) => void) | undefined;
    let sharedSignal: AbortSignal | undefined;
    api.seriesPart = vi.fn((_run, _variant, _cell, _replication, _part, signal?: AbortSignal) => new Promise((resolve) => {
      resolvePart = resolve;
      sharedSignal = signal;
    }));
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });
    const controller = new AbortController();
    const nodes = loader.load(request(["client"], controller.signal));
    const connections = loader.loadConnections({ ...request([]), connections: ["call"] });
    await vi.waitFor(() => expect(resolvePart).toBeDefined());
    const aborted = nodes.catch((error: unknown) => error);

    expect(api.seriesPart).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(sharedSignal?.aborted).toBe(false);
    resolvePart!({ text, etag: `"${CLIENT_SHA}"` });

    await expect(aborted).resolves.toMatchObject({ name: "AbortError" });
    expect((await connections)[0].windows[0].sentAttempts).toBe(3);
    expect(api.seriesPart).toHaveBeenCalledTimes(1);
  });

  it("reuses a completed download while another view is still decoding that part", async () => {
    const { index } = fixture();
    const mixed = part([{ id: "client", windows: [window({ originalArrivals: 7 }), window({ startMs: 10 })] }]);
    mixed.connections = [{ id: "call", windows: [0, 10].map((startMs) => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: 10,
      sentAttempts: 3,
      retries: 1,
      succeeded: 1,
      failed: 0,
      timeouts: 1,
      orphaned: 1,
      inFlightIntegralMs: 5,
      orphanedIntegralMs: 3,
      backoffIntegralMs: 2,
      latency: { count: 1, sumMs: 2, sketch: [0, 64, 1] },
      slotPools: {  } })) }];
    const text = JSON.stringify(mixed);
    const api = apiFor({ ...index, parts: [{ ...index.parts[0], connections: ["call"], uncompressedBytes: text.length }] }, [text]);
    const pending: (() => void)[] = [];
    const loader = new SeriesLoader({ api, decoderFactory: () => ({
      decode: (texts) => new Promise((resolve) => pending.push(() => resolve(texts.map(decodeSeriesPart)))), close: () => {},
    }) });
    const nodes = loader.load(request(["client"]));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const connections = loader.loadConnections({ ...request([]), connections: ["call"] });
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    expect(api.seriesPart).toHaveBeenCalledTimes(1);
    for (const resolve of pending) resolve();

    expect((await nodes)[0].windows[0].originalArrivals).toBe(7);
    expect((await connections)[0].windows[0].sentAttempts).toBe(3);
  });

  it("keeps service latency sample counts and sums aligned with the exact selected windows", async () => {
    const measured = part([
      { id: "client", windows: [window({ originalArrivals: 1 }), window({ startMs: 10 }), window({ startMs: 20, durationMs: 5 })] },
      { id: "service", windows: [
        window({ latency: { count: 100, sumMs: 10000, sketch: [0, 64, 100] },
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (1) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }),
        window({ startMs: 10,
      latency: { count: 1, sumMs: 10, sketch: [0, 64, 1] },
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (1) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }),
        window({ startMs: 20,
      durationMs: 5,
      latency: { count: 2, sumMs: 80, sketch: [0, 64, 2] },
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (1) * (5), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }),
      ] },
    ], 0, 3);
    const text = JSON.stringify(measured);
    const index: SeriesIndex = { groups: [], schemaVersion: 7, endMs: 25, windowMs: 10, parts: [{
      kind: "INSTANCE", file: "part-0.json.gz", nodes: ["client", "service"], classes: [], connections: [], fromWindow: 0, untilWindow: 3,
      uncompressedBytes: text.length, sha256: CLIENT_SHA,
    }] };
    const loader = new SeriesLoader({ api: apiFor(index, [text]), decoderFactory: decoderFactory() });

    const result = await loader.load({ ...request(["service"]), fromWindow: 1, untilWindow: 3 });

    expect(result[0].latency).toEqual([{ count: 1, sumMs: 10 }, { count: 2, sumMs: 80 }]);
    expect(result[0].windows.map((value) => [value.startMs, value.durationMs])).toEqual([[10, 10], [20, 5]]);
  });

  it.each([1, 2, 3, 4, 5, 6, 8])("rejects unsupported index schema version %s", async (schemaVersion) => {
    const { index, texts } = fixture();
    const api = apiFor({ ...index, schemaVersion }, texts);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    await expect(loader.load(request(["client"]))).rejects.toMatchObject({ code: "INVALID_SERIES" });
  });

  it("accounts for expanded connection rows before retaining a decoded part", async () => {
    const { index } = fixture();
    const mixed = part([{ id: "client", windows: [window({ originalArrivals: 1 }), window({ startMs: 10 })] }]);
    mixed.connections = [{ id: "call".repeat(30), windows: [0, 10].map((startMs) => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: 10,
      sentAttempts: 1,
      retries: 0,
      succeeded: 1,
      failed: 0,
      timeouts: 0,
      orphaned: 0,
      inFlightIntegralMs: 2,
      orphanedIntegralMs: 0,
      backoffIntegralMs: 0,
      latency: { count: 1, sumMs: 2, sketch: [0, 64, 1] },
      slotPools: {  } })) }];
    const text = JSON.stringify(mixed);
    const cache = new SeriesPartCache(text.length + 1);
    const api = apiFor({ ...index, parts: [{ ...index.parts[0], connections: [mixed.connections[0].id], uncompressedBytes: text.length }] }, [text]);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory(), cache });

    await loader.load(request(["client"]));

    expect(cache.estimatedBytes).toBe(0);
  });

  it("passes connection-only split parts while finding the client denominator", async () => {
    const { index, texts } = fixture();
    const connection = part([]);
    connection.connections = [{ id: "call", windows: [0, 10].map((startMs) => ({
      failuresByReason: {}, circuitOpenMs: 0, circuitRejections: 0, retriesDenied: 0, fallbacks: 0, startMs,
      durationMs: 10,
      sentAttempts: 1,
      retries: 0,
      succeeded: 0,
      failed: 0,
      timeouts: 1,
      orphaned: 1,
      inFlightIntegralMs: 5,
      orphanedIntegralMs: 5,
      backoffIntegralMs: 0,
      latency: { count: 0, sumMs: 0, sketch: [0] },
      slotPools: {  } })) }];
    const allTexts = [JSON.stringify(connection), texts[1], texts[0]];
    const expandedIndex: SeriesIndex = {
      ...index,
      parts: [
        { ...index.parts[0], nodes: [], classes: [], connections: ["call"], uncompressedBytes: allTexts[0].length },
        index.parts[1],
        { ...index.parts[0], kind: "INSTANCE", file: "part-2.json.gz", classes: [], connections: [], uncompressedBytes: allTexts[2].length },
      ],
    };
    const cache = new SeriesPartCache();
    const api = apiFor(expandedIndex, allTexts);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory(), cache });

    const result = await loader.load(request(["service"]));

    expect(result[0].windows.map((value) => calculateOutput(outputsOf(catalog, "request")[0].calculation, { target: value, entries: value.entries }))).toEqual([1.5, 2]);
    expect(cache.get({ runId: "run", variant: "baseline", cell: "p0", replication: 0, part: 0 })?.connections[0].id).toBe("call");
  });

  it("loads only requested parts and reuses decoded cache entries", async () => {
    const { index, texts } = fixture();
    const api = apiFor(index, texts);
    const factory = vi.fn(decoderFactory());
    const loader = new SeriesLoader({ api, decoderFactory: factory });

    const first = await loader.load(request(["client"]));
    const second = await loader.load(request(["client"]));

    expect(first[0].windows).toHaveLength(2);
    expect(first[0].windows[1].originalArrivals).toBe(20);
    expect(second).toEqual(first);
    expect(api.seriesPart).toHaveBeenCalledTimes(1);
    expect(api.seriesPart).toHaveBeenCalledWith("run", "baseline", "p0", 0, 0, expect.any(AbortSignal));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("loads all overlapping instance parts and reuses one decoder during fallback", async () => {
    const { index, texts } = fixture();
    const unrelated = part([{ id: "unrelated", windows: [window({ slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (1) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } }), window({ startMs: 10,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (1) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } })] }]);
    const allTexts = [...texts, JSON.stringify(unrelated)];
    const expandedIndex: SeriesIndex = {
      ...index,
      parts: [...index.parts, {
        kind: "INSTANCE", file: "part-2.json.gz",
        nodes: ["unrelated"],
        classes: [], connections: [],
        fromWindow: 0,
        untilWindow: 2,
        uncompressedBytes: allTexts[2].length,
        sha256: "c".repeat(64),
      }],
    };
    const api = apiFor(expandedIndex, allTexts);
    const close = vi.fn();
    const factory = vi.fn(() => ({
      decode: async (values: readonly string[]) => values.map(decodeSeriesPart),
      close,
    }));
    const loader = new SeriesLoader({ api, decoderFactory: factory });

    const result = await loader.load(request(["service"]));

    expect(result[0].windows.map((value) => calculateOutput(outputsOf(catalog, "request")[0].calculation, { target: value, entries: value.entries }))).toEqual([1.5, 2]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(api.seriesPart.mock.calls.map((call) => call[4])).toEqual([1, 0, 2]);
  });

  it("finds a missing client window after a full window and a split window", async () => {
    const parts = [
      part([
        { id: "client", windows: [window({ originalArrivals: 10 })] },
        { id: "service", windows: [window({ admittedAttempts: 15,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (2) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } })] },
      ], 0, 1),
      part([{ id: "service", windows: [window({ startMs: 10,
      admittedAttempts: 40,
      slotPools: { handlers: { busyIntegralMs: 0, queueIntegralMs: 0, capacityIntegralMs: (2) * (10), waitCount: 0, totalWaitMs: 0, queueFullCount: 0, waitLimitCount: 0 } } })] }], 1, 2),
      part([{ id: "client", windows: [window({ startMs: 10, originalArrivals: 20 })] }], 1, 2),
    ];
    const texts = parts.map((value) => JSON.stringify(value));
    const index: SeriesIndex = { groups: [],
      schemaVersion: 7,
      endMs: 20,
      windowMs: 10,
      parts: [
        { kind: "INSTANCE", file: "part-0.json.gz", nodes: ["client", "service"], classes: [], connections: [], fromWindow: 0, untilWindow: 1, uncompressedBytes: texts[0].length, sha256: CLIENT_SHA },
        { kind: "INSTANCE", file: "part-1.json.gz", nodes: ["service"], classes: [], connections: [], fromWindow: 1, untilWindow: 2, uncompressedBytes: texts[1].length, sha256: SERVICE_SHA },
        { kind: "INSTANCE", file: "part-2.json.gz", nodes: ["client"], classes: [], connections: [], fromWindow: 1, untilWindow: 2, uncompressedBytes: texts[2].length, sha256: "c".repeat(64) },
      ],
    };
    const api = apiFor(index, texts);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    const result = await loader.load(request(["service"]));

    expect(result[0].windows.map((value) => calculateOutput(outputsOf(catalog, "request")[0].calculation, { target: value, entries: value.entries }))).toEqual([1.5, 2]);
    expect(api.seriesPart.mock.calls.map((call) => call[4])).toEqual([0, 1, 2]);
  });

  it("rejects an ETag that does not match the index checksum", async () => {
    const { index, texts } = fixture();
    const api = apiFor(index, texts, ["\"wrong\"", `"${SERVICE_SHA}"`]);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    const error = await loader.load(request(["client"])).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SeriesLoadError);
    expect((error as SeriesLoadError).code).toBe("ETAG_MISMATCH");
    expect((error as Error).message).toContain("part-0.json.gz");
  });

  it("maps missing series to an explicit unavailable state", async () => {
    const api: SeriesApi = {
      seriesIndex: async () => {
        throw new ApiError(404, { code: "SERIES_NOT_FOUND", message: "missing", diagnostics: [] });
      },
      seriesPart: async () => { throw new Error("not used"); },
    };
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    const error = await loader.load(request(["client"])).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SeriesLoadError);
    expect((error as SeriesLoadError).code).toBe("SERIES_NOT_FOUND");
    expect((error as Error).message).toBe("Series are unavailable for this run, variant, point and replication.");
  });

  it("aborts obsolete work and never decodes a late response", async () => {
    const { index, texts } = fixture();
    let resolvePart: ((value: { text: string; etag: string }) => void) | undefined;
    const api: SeriesApi = {
      seriesIndex: async () => index,
      seriesPart: (_run, _variant, _cell, _replication, _part, signal) => new Promise((resolve) => {
        resolvePart = resolve;
        expect(signal?.aborted).toBe(false);
      }),
    };
    const factory = vi.fn(decoderFactory());
    const loader = new SeriesLoader({ api, decoderFactory: factory });
    const controller = new AbortController();
    const loading = loader.load(request(["client"], controller.signal));
    await vi.waitFor(() => expect(resolvePart).toBeDefined());

    controller.abort();
    resolvePart!({ text: texts[0], etag: `"${CLIENT_SHA}"` });

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
  });
});
