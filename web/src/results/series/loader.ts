import { t } from "../../i18n";
import { MessageError } from "../../i18n/MessageError";
import { ApiError, api } from "../../api/apiClient";
import type { SeriesIndex } from "../../api/apiTypes";
import { DEFAULT_SERIES_CACHE_BYTES, SeriesPartCache, type SeriesPartKey } from "./cache";
import { selectSeriesParts } from "./selection";
import type { DecodedConnection, DecodedConnectionWindow, DecodedSeriesPart, DecodedWindow, NodeSeriesMetrics } from "./types";
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

export type ConnectionSeriesLoadRequest = Omit<SeriesLoadRequest, "nodes"> & { connections: readonly string[] };
type SeriesSelectionRequest = SeriesLoadRequest | ConnectionSeriesLoadRequest;
interface PartDownload {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: ReturnType<SeriesApi["seriesPart"]>;
}

export type SeriesLoadErrorCode = "SERIES_NOT_FOUND" | "ETAG_MISMATCH" | "INVALID_SERIES" | "WORKER_ERROR";

export class SeriesLoadError extends Error {
  constructor(readonly code: SeriesLoadErrorCode, message: string | Error | (() => string)) {
    const text = () => typeof message === "function" ? message() : typeof message === "string" ? message : message.message;
    super(text());
    this.name = "SeriesLoadError";
    if (typeof message !== "string") Object.defineProperty(this, "message", { get: text });
  }
}

export interface SeriesLoaderOptions {
  api?: SeriesApi;
  decoderFactory?: SeriesDecoderFactory;
  cache?: SeriesPartCache;
}

/** Loads selected immutable parts, decodes them off-thread and returns only requested element × window metrics. */
export class SeriesLoader {
  private readonly api: SeriesApi;
  private readonly decoderFactory: SeriesDecoderFactory;
  private readonly cache: SeriesPartCache;
  private readonly downloads = new Map<string, PartDownload>();

  constructor(options: SeriesLoaderOptions = {}) {
    this.api = options.api ?? api;
    this.decoderFactory = options.decoderFactory ?? (() => new WorkerSeriesDecoder());
    this.cache = options.cache ?? new SeriesPartCache(DEFAULT_SERIES_CACHE_BYTES);
  }

  async load(request: SeriesLoadRequest): Promise<NodeSeriesMetrics[]> {
    return assemble(await this.loadRequest(request), request);
  }

  async loadConnections(request: ConnectionSeriesLoadRequest): Promise<DecodedConnection[]> {
    return assembleConnections(await this.loadRequest(request), request);
  }

  private async loadRequest(request: SeriesSelectionRequest): Promise<Map<string, DecodedSeriesPart>> {
    throwIfAborted(request.signal);
    let decoder: SeriesDecoder | undefined;
    const getDecoder = () => {
      decoder ??= this.decoderFactory();
      return decoder;
    };
    try {
      const loading = this.loadInternal(request, getDecoder);
      return await withAbort(loading, request.signal, () => decoder?.close());
    } catch (error) {
      if (error instanceof SeriesLoadError || isAbort(error)) throw error;
      if (error instanceof ApiError && error.status === 404 && error.problem.code === "SERIES_NOT_FOUND") {
        throw new SeriesLoadError("SERIES_NOT_FOUND", new MessageError("results.series.unavailable"));
      }
      throw new SeriesLoadError("WORKER_ERROR", new MessageError("results.series.couldNotLoad", { get message() { return messageOf(error); } }));
    } finally {
      decoder?.close();
    }
  }

  private async loadInternal(
    request: SeriesSelectionRequest,
    getDecoder: () => SeriesDecoder,
  ): Promise<Map<string, DecodedSeriesPart>> {
    const index = await this.api.seriesIndex(
      request.runId,
      request.variant,
      request.cell,
      request.replication,
      request.signal,
    );
    throwIfAborted(request.signal);
    if (index.schemaVersion !== 2) {
      throw new SeriesLoadError("INVALID_SERIES", new MessageError("results.series.unsupportedIndexSchema", { version: String(index.schemaVersion) }));
    }
    const connectionRequest = "connections" in request;
    const selected = selectSeriesParts(index, connectionRequest ? [] : request.nodes,
      request.fromWindow, request.untilWindow, connectionRequest ? request.connections : []);
    const parts = await this.loadReferences(request, selected, getDecoder);
    if (!connectionRequest) await this.ensureClients(index, parts, request, getDecoder);
    return parts;
  }

  private async ensureClients(
    index: SeriesIndex,
    parts: Map<string, DecodedSeriesPart>,
    request: SeriesLoadRequest,
    getDecoder: () => SeriesDecoder,
  ): Promise<void> {
    let missing = missingClientWindows(parts, request);
    while (missing.size > 0) {
      const clientIds = clientIdsOf(parts);
      const clientParts = index.parts.filter((reference) =>
        !parts.has(reference.file) && reference.nodes.some((id) => clientIds.has(id)) && overlapsAny(reference, missing),
      );
      const candidate = clientParts[0] ?? index.parts.find((reference) =>
        !parts.has(reference.file) && overlapsAny(reference, missing),
      );
      if (candidate === undefined) {
        throw new SeriesLoadError("INVALID_SERIES", new MessageError("results.series.missingClients"));
      }
      const extra = await this.loadReferences(request, [candidate], getDecoder);
      for (const [file, part] of extra) parts.set(file, part);
      missing = missingClientWindows(parts, request);
    }
  }

  /** A cancelled view releases only its own interest in a part another view still needs. */
  private downloadPart(request: SeriesSelectionRequest, reference: SeriesPartReference) {
    throwIfAborted(request.signal);
    const key = JSON.stringify(cacheKey(request, reference));
    let download = this.downloads.get(key);
    if (download === undefined) {
      const controller = new AbortController();
      download = { controller, consumers: new Set(), promise: this.api.seriesPart(
        request.runId, request.variant, request.cell, request.replication, partNumberOf(reference), controller.signal,
      ) };
      this.downloads.set(key, download);
      const completed = download;
      const clear = () => { if (this.downloads.get(key) === completed) this.downloads.delete(key); };
      void download.promise.then(() => {}, clear);
    }
    const shared = download;
    const consumer = Symbol();
    shared.consumers.add(consumer);
    const release = () => {
      if (shared.consumers.delete(consumer) && shared.consumers.size === 0) {
        shared.controller.abort();
        if (this.downloads.get(key) === shared) this.downloads.delete(key);
      }
    };
    return { promise: withAbort(shared.promise, request.signal, release), release };
  }

  private async loadReferences(
    request: SeriesSelectionRequest,
    references: readonly SeriesPartReference[],
    getDecoder: () => SeriesDecoder,
  ): Promise<Map<string, DecodedSeriesPart>> {
    const result = new Map<string, DecodedSeriesPart>();
    const missing: SeriesPartReference[] = [];
    for (const reference of references) {
      const cached = this.cache.get(cacheKey(request, reference));
      if (cached === undefined) missing.push(reference);
      else result.set(reference.file, cached);
    }
    if (missing.length === 0) return result;

    const downloads = missing.map((reference) => ({ reference, ...this.downloadPart(request, reference) }));
    try {
      const fetched = await Promise.all(downloads.map(async ({ reference, promise }) => {
        const partNumber = partNumberOf(reference);
        const raw = await promise;
        throwIfAborted(request.signal);
        const expected = `"${reference.sha256}"`;
        if (raw.etag !== expected) {
          throw new SeriesLoadError(
            "ETAG_MISMATCH",
            new MessageError("results.series.etagMismatch", { file: reference.file, get etag() { return raw.etag ?? t("results.series.missingEtag"); }, expected }),
          );
        }
        return { reference, partNumber, text: raw.text };
      }));
      const decoded = await getDecoder().decode(fetched.map((part) => part.text));
      throwIfAborted(request.signal);
      if (decoded.length !== fetched.length) {
        throw new SeriesLoadError("INVALID_SERIES", new MessageError("results.series.partCountMismatch"));
      }
      for (const [offset, part] of decoded.entries()) {
        const source = fetched[offset];
        this.cache.put(cacheKey(request, source.reference), part, estimatedBytes(source.reference, part));
        result.set(source.reference.file, part);
      }
      return result;
    } finally {
      for (const download of downloads) download.release();
    }
  }
}

function cacheKey(request: SeriesSelectionRequest, reference: SeriesPartReference): SeriesPartKey {
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
  if (match === null) throw new SeriesLoadError("INVALID_SERIES", new MessageError("results.series.invalidPartFile", { file: reference.file }));
  return Number(match[1]);
}

function estimatedBytes(reference: SeriesPartReference, part: DecodedSeriesPart): number {
  const decodedEstimate = [...part.nodes, ...part.connections].reduce(
    (total, node) => total + 64 + node.id.length * 2 + node.windows.length * 512,
    64,
  );
  return Math.max(reference.uncompressedBytes, decodedEstimate);
}

function clientIdsOf(parts: ReadonlyMap<string, DecodedSeriesPart>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const part of parts.values()) {
    for (const node of part.nodes) {
      if (node.windows.every((window) => window.handlers === 0)) result.add(node.id);
    }
  }
  return result;
}

function missingClientWindows(parts: ReadonlyMap<string, DecodedSeriesPart>, request: SeriesLoadRequest): Set<number> {
  const requested = new Set(request.nodes);
  const covered = new Set<number>();
  const services = new Set<number>();
  for (const part of parts.values()) {
    for (const node of part.nodes) {
      const client = node.windows.every((window) => window.handlers === 0);
      for (const [offset, window] of node.windows.entries()) {
        const index = part.fromWindow + offset;
        if (index < request.fromWindow || index >= request.untilWindow) continue;
        if (client) covered.add(index);
        else if (requested.has(node.id) && window.handlers > 0) services.add(index);
      }
    }
  }
  return new Set([...services].filter((index) => !covered.has(index)));
}

function overlapsAny(reference: SeriesPartReference, windows: ReadonlySet<number>): boolean {
  for (const window of windows) {
    if (reference.fromWindow <= window && window < reference.untilWindow) return true;
  }
  return false;
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
    const ordered = [...selectedWindows.entries()].sort(([a], [b]) => a - b);
    const windows = ordered.map(([index, window]) => {
      const metrics = { ...window.metrics };
      if (window.handlers > 0) {
        const denominator = arrivals.get(index) ?? 0;
        metrics.client = { originalArrivals: denominator };
      }
      return metrics;
    });
    return [{ id, windows, latency: ordered.map(([, window]) => window.latency) }];
  });
}

function assembleConnections(
  parts: ReadonlyMap<string, DecodedSeriesPart>, request: ConnectionSeriesLoadRequest,
): DecodedConnection[] {
  const selected = new Map<string, Map<number, DecodedConnectionWindow>>();
  const requested = new Set(request.connections);
  for (const part of parts.values()) {
    for (const connection of part.connections) {
      if (!requested.has(connection.id)) continue;
      for (const [offset, window] of connection.windows.entries()) {
        const index = part.fromWindow + offset;
        if (index < request.fromWindow || index >= request.untilWindow) continue;
        let windows = selected.get(connection.id);
        if (windows === undefined) {
          windows = new Map();
          selected.set(connection.id, windows);
        }
        windows.set(index, window);
      }
    }
  }
  return [...requested].flatMap((id) => {
    const windows = selected.get(id);
    return windows === undefined ? [] : [{ id, windows: [...windows.entries()].sort(([a], [b]) => a - b).map(([, window]) => window) }];
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new DOMException(t("results.series.aborted"), "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException(t("results.series.aborted"), "AbortError");
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
