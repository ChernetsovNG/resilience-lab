import { ApiError, api } from "../../api/apiClient";
import type { SeriesIndex } from "../../api/apiTypes";
import { DEFAULT_SERIES_CACHE_BYTES, SeriesPartCache, type SeriesPartKey } from "./cache";
import { selectSeriesParts } from "./selection";
import type { DecodedSeriesPart, DecodedWindow, NodeSeriesMetrics } from "./types";
import { WorkerSeriesDecoder } from "./workerClient";

type SeriesPartReference = SeriesIndex["parts"][number];

export interface SeriesApi {
  seriesIndex(runId: string, variant: string, cell: string, replication: number, signal?: AbortSignal): Promise<SeriesIndex>;
  seriesPart(
    runId: string,
    variant: string,
    cell: string,
    replication: number,
    part: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; etag: string | null }>;
}

export interface SeriesDecoder {
  decode(texts: readonly string[]): Promise<DecodedSeriesPart[]>;
  close(): void;
}

export type SeriesDecoderFactory = () => SeriesDecoder;

export interface SeriesLoadRequest {
  runId: string;
  variant: string;
  cell: string;
  replication: number;
  nodes: readonly string[];
  fromWindow: number;
  untilWindow: number;
  signal?: AbortSignal;
}

export type SeriesLoadErrorCode = "SERIES_NOT_FOUND" | "ETAG_MISMATCH" | "INVALID_SERIES" | "WORKER_ERROR";

export class SeriesLoadError extends Error {
  constructor(readonly code: SeriesLoadErrorCode, message: string) {
    super(message);
    this.name = "SeriesLoadError";
  }
}

export interface SeriesLoaderOptions {
  api?: SeriesApi;
  decoderFactory?: SeriesDecoderFactory;
  cache?: SeriesPartCache;
}

/** Loads selected immutable parts, decodes them off-thread and returns only requested node × window metrics. */
export class SeriesLoader {
  private readonly api: SeriesApi;
  private readonly decoderFactory: SeriesDecoderFactory;
  private readonly cache: SeriesPartCache;

  constructor(options: SeriesLoaderOptions = {}) {
    this.api = options.api ?? api;
    this.decoderFactory = options.decoderFactory ?? (() => new WorkerSeriesDecoder());
    this.cache = options.cache ?? new SeriesPartCache(DEFAULT_SERIES_CACHE_BYTES);
  }

  async load(request: SeriesLoadRequest): Promise<NodeSeriesMetrics[]> {
    throwIfAborted(request.signal);
    let decoder: SeriesDecoder | undefined;
    try {
      const loading = this.loadInternal(request, (value) => { decoder = value; });
      return await withAbort(loading, request.signal, () => decoder?.close());
    } catch (error) {
      if (error instanceof SeriesLoadError || isAbort(error)) throw error;
      if (error instanceof ApiError && error.status === 404 && error.problem.code === "SERIES_NOT_FOUND") {
        throw new SeriesLoadError("SERIES_NOT_FOUND", "Series are unavailable for this run, variant, point and replication.");
      }
      throw new SeriesLoadError("WORKER_ERROR", `Series could not be loaded: ${messageOf(error)}`);
    } finally {
      decoder?.close();
    }
  }

  private async loadInternal(
    request: SeriesLoadRequest,
    setDecoder: (decoder: SeriesDecoder) => void,
  ): Promise<NodeSeriesMetrics[]> {
    const index = await this.api.seriesIndex(
      request.runId,
      request.variant,
      request.cell,
      request.replication,
      request.signal,
    );
    throwIfAborted(request.signal);
    const selected = selectSeriesParts(index, request.nodes, request.fromWindow, request.untilWindow);
    const parts = await this.loadReferences(request, selected, setDecoder);
    if (needsClient(parts, request.nodes)) {
      const allNodes = index.parts.flatMap((part) => part.nodes);
      const remaining = selectSeriesParts(index, allNodes, request.fromWindow, request.untilWindow)
        .filter((reference) => !parts.has(reference.file));
      if (remaining.length > 0) {
        const extra = await this.loadReferences(request, remaining, setDecoder);
        for (const [file, part] of extra) parts.set(file, part);
      }
    }
    return assemble(parts, request);
  }

  private async loadReferences(
    request: SeriesLoadRequest,
    references: readonly SeriesPartReference[],
    setDecoder: (decoder: SeriesDecoder) => void,
  ): Promise<Map<string, DecodedSeriesPart>> {
    const result = new Map<string, DecodedSeriesPart>();
    const missing: SeriesPartReference[] = [];
    for (const reference of references) {
      const cached = this.cache.get(cacheKey(request, reference));
      if (cached === undefined) missing.push(reference);
      else result.set(reference.file, cached);
    }
    if (missing.length === 0) return result;

    const fetched = await Promise.all(missing.map(async (reference) => {
      const partNumber = partNumberOf(reference);
      const raw = await this.api.seriesPart(
        request.runId,
        request.variant,
        request.cell,
        request.replication,
        partNumber,
        request.signal,
      );
      throwIfAborted(request.signal);
      const expected = `"${reference.sha256}"`;
      if (raw.etag !== expected) {
        throw new SeriesLoadError(
          "ETAG_MISMATCH",
          `Series part ${reference.file} ETag ${raw.etag ?? "missing"} does not match index SHA-256 ${expected}.`,
        );
      }
      return { reference, partNumber, text: raw.text };
    }));
    const decoder = this.decoderFactory();
    setDecoder(decoder);
    const decoded = await decoder.decode(fetched.map((part) => part.text));
    throwIfAborted(request.signal);
    if (decoded.length !== fetched.length) {
      throw new SeriesLoadError("INVALID_SERIES", "Series worker returned a different number of parts.");
    }
    for (const [offset, part] of decoded.entries()) {
      const source = fetched[offset];
      this.cache.put(cacheKey(request, source.reference), part, estimatedBytes(source.reference, part));
      result.set(source.reference.file, part);
    }
    return result;
  }
}

function cacheKey(request: SeriesLoadRequest, reference: SeriesPartReference): SeriesPartKey {
  return {
    runId: request.runId,
    variant: request.variant,
    cell: request.cell,
    replication: request.replication,
    part: partNumberOf(reference),
  };
}

function partNumberOf(reference: SeriesPartReference): number {
  const match = /^part-(\d+)\.json\.gz$/.exec(reference.file);
  if (match === null) throw new SeriesLoadError("INVALID_SERIES", `Invalid series part file: ${reference.file}`);
  return Number(match[1]);
}

function estimatedBytes(reference: SeriesPartReference, part: DecodedSeriesPart): number {
  const decodedEstimate = part.nodes.reduce(
    (total, node) => total + 64 + node.id.length * 2 + node.windows.length * 512,
    64,
  );
  return Math.max(reference.uncompressedBytes, decodedEstimate);
}

function needsClient(parts: ReadonlyMap<string, DecodedSeriesPart>, requestedNodes: readonly string[]): boolean {
  const requested = new Set(requestedNodes);
  let service = false;
  let client = false;
  for (const part of parts.values()) {
    for (const node of part.nodes) {
      const isClient = node.windows.every((window) => window.handlers === 0);
      client ||= isClient;
      service ||= requested.has(node.id) && node.windows.some((window) => window.handlers > 0);
    }
  }
  return service && !client;
}

function assemble(parts: ReadonlyMap<string, DecodedSeriesPart>, request: SeriesLoadRequest): NodeSeriesMetrics[] {
  const arrivals = new Map<number, number>();
  const selected = new Map<string, Map<number, DecodedWindow>>();
  const requested = new Set(request.nodes);
  for (const part of parts.values()) {
    for (const node of part.nodes) {
      for (const [offset, window] of node.windows.entries()) {
        const index = part.fromWindow + offset;
        if (index < request.fromWindow || index >= request.untilWindow) continue;
        if (window.handlers === 0) arrivals.set(index, (arrivals.get(index) ?? 0) + window.originalArrivals);
        if (!requested.has(node.id)) continue;
        let windows = selected.get(node.id);
        if (windows === undefined) {
          windows = new Map();
          selected.set(node.id, windows);
        }
        windows.set(index, window);
      }
    }
  }
  return [...requested].flatMap((id) => {
    const selectedWindows = selected.get(id);
    if (selectedWindows === undefined) return [];
    const windows = [...selectedWindows.entries()].sort(([a], [b]) => a - b).map(([index, window]) => {
      const metrics = { ...window.metrics };
      if (window.handlers > 0) {
        const denominator = arrivals.get(index) ?? 0;
        metrics.amplification = denominator === 0 ? null : window.admittedAttempts / denominator;
      }
      return metrics;
    });
    return [{ id, windows }];
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new DOMException("The series load was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The series load was aborted.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
