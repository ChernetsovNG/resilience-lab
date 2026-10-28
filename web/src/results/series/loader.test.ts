import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/apiClient";
import type { SeriesIndex, SeriesPart, WindowMetrics } from "../../api/apiTypes";
import { decodeSeriesPart } from "./decode";
import { SeriesLoadError, SeriesLoader, type SeriesApi, type SeriesDecoderFactory } from "./loader";

const CLIENT_SHA = "a".repeat(64);
const SERVICE_SHA = "b".repeat(64);

function window(values: Partial<WindowMetrics> = {}): WindowMetrics {
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

function part(nodes: SeriesPart["nodes"]): SeriesPart {
  return { schemaVersion: 1, profile: "ddsketch-bitwise6-rational-v1", fromWindow: 0, untilWindow: 2, nodes };
}

function fixture() {
  const client = part([{ id: "client", windows: [
    window({ originalArrivals: 10 }),
    window({ startMs: 10, originalArrivals: 20 }),
  ] }]);
  const service = part([{ id: "service", windows: [
    window({ handlers: 2, admittedAttempts: 15 }),
    window({ startMs: 10, handlers: 2, admittedAttempts: 40 }),
  ] }]);
  const texts = [JSON.stringify(client), JSON.stringify(service)];
  const index: SeriesIndex = {
    schemaVersion: 1,
    endMs: 20,
    windowMs: 10,
    parts: [
      { file: "part-0.json.gz", nodes: ["client"], fromWindow: 0, untilWindow: 2, uncompressedBytes: texts[0].length, sha256: CLIENT_SHA },
      { file: "part-1.json.gz", nodes: ["service"], fromWindow: 0, untilWindow: 2, uncompressedBytes: texts[1].length, sha256: SERVICE_SHA },
    ],
  };
  return { index, texts };
}

function apiFor(index: SeriesIndex, texts: string[], etags = [`"${CLIENT_SHA}"`, `"${SERVICE_SHA}"`]) {
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
  it("loads only requested parts and reuses decoded cache entries", async () => {
    const { index, texts } = fixture();
    const api = apiFor(index, texts);
    const factory = vi.fn(decoderFactory());
    const loader = new SeriesLoader({ api, decoderFactory: factory });

    const first = await loader.load(request(["client"]));
    const second = await loader.load(request(["client"]));

    expect(first[0].windows).toHaveLength(2);
    expect(first[0].windows[1].originalArrivalsPerSecond).toBe(2000);
    expect(second).toEqual(first);
    expect(api.seriesPart).toHaveBeenCalledTimes(1);
    expect(api.seriesPart).toHaveBeenCalledWith("run", "baseline", "p0", 0, 0, undefined);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("loads a client part when a selected service needs its amplification denominator", async () => {
    const { index, texts } = fixture();
    const api = apiFor(index, texts);
    const loader = new SeriesLoader({ api, decoderFactory: decoderFactory() });

    const result = await loader.load(request(["service"]));

    expect(result[0].windows.map((value) => value.amplification)).toEqual([1.5, 2]);
    expect(api.seriesPart.mock.calls.map((call) => call[4])).toEqual([1, 0]);
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
