import type { DecodedSeriesPart } from "./types";

export const DEFAULT_SERIES_CACHE_BYTES = 64 * 1024 * 1024;

export interface SeriesPartKey {
  runId: string;
  variant: string;
  cell: string;
  replication: number;
  part: number;
}

interface CacheEntry {
  key: SeriesPartKey;
  value: DecodedSeriesPart;
  bytes: number;
}

/** Immutable decoded-part LRU; keys include the complete run task and part number. */
export class SeriesPartCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(private readonly limitBytes = DEFAULT_SERIES_CACHE_BYTES) {}

  get estimatedBytes(): number {
    return this.bytes;
  }

  get(key: SeriesPartKey): DecodedSeriesPart | undefined {
    const id = identity(key);
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  put(key: SeriesPartKey, value: DecodedSeriesPart, estimatedBytes: number): void {
    const id = identity(key);
    const previous = this.entries.get(id);
    if (previous !== undefined) {
      this.bytes -= previous.bytes;
      this.entries.delete(id);
    }
    if (estimatedBytes > this.limitBytes) return;
    this.entries.set(id, { key, value, bytes: estimatedBytes });
    this.bytes += estimatedBytes;
    while (this.bytes > this.limitBytes) {
      const oldest = this.entries.keys().next().value as string;
      const entry = this.entries.get(oldest)!;
      this.bytes -= entry.bytes;
      this.entries.delete(oldest);
    }
  }
}

function identity(key: SeriesPartKey): string {
  return JSON.stringify([key.runId, key.variant, key.cell, key.replication, key.part]);
}
