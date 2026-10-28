import { describe, expect, it } from "vitest";
import { SeriesPartCache, type SeriesPartKey } from "./cache";
import type { DecodedSeriesPart } from "./types";

const part: DecodedSeriesPart = { fromWindow: 0, untilWindow: 1, nodes: [] };

function key(partNumber: number, runId = "run"): SeriesPartKey {
  return { runId, variant: "baseline", cell: "p0", replication: 0, part: partNumber };
}

describe("series part cache", () => {
  it("evicts least recently used decoded parts above the byte limit", () => {
    const cache = new SeriesPartCache(100);
    cache.put(key(0), part, 40);
    cache.put(key(1), part, 50);
    expect(cache.get(key(0))).toBe(part);

    cache.put(key(2), part, 40);

    expect(cache.get(key(1))).toBeUndefined();
    expect(cache.get(key(0))).toBe(part);
    expect(cache.get(key(2))).toBe(part);
    expect(cache.estimatedBytes).toBe(80);

    cache.put(key(3), part, 60);

    expect(cache.get(key(0))).toBeUndefined();
    expect(cache.get(key(2))).toBe(part);
    expect(cache.get(key(3))).toBe(part);
    expect(cache.estimatedBytes).toBe(100);
  });

  it("does not retain a part larger than the whole cache", () => {
    const cache = new SeriesPartCache(100);

    cache.put(key(0), part, 101);

    expect(cache.get(key(0))).toBeUndefined();
    expect(cache.estimatedBytes).toBe(0);
  });

  it("separates identical parts from different runs", () => {
    const cache = new SeriesPartCache(100);
    const other = { ...part };
    cache.put(key(0), part, 40);
    cache.put(key(0, "other-run"), other, 40);

    expect(cache.get(key(0))).toBe(part);
    expect(cache.get(key(0, "other-run"))).toBe(other);
  });
});
