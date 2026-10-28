import type { Catalog, ExperimentFile } from "../../api/apiTypes";
import { canonicalOf } from "../../workspace/quantities";

export interface TimelinePoint { window: number; startMs: number; value: number | null }
export interface TimelineRegion { fromMs: number; toMs: number; label: string; kind: "warmup" | "fault" }

/** First, last, min and max per screen pixel, plus both edges of every missing-value gap. */
export function downsample(points: readonly TimelinePoint[], pixels: number): TimelinePoint[] {
  if (points.length <= Math.max(1, pixels)) return [...points];
  const count = Math.max(1, Math.floor(pixels));
  const start = points[0].startMs;
  const span = points.at(-1)!.startMs - start || 1;
  const keep = new Set<number>([0, points.length - 1]);
  let bucket = -1;
  let first = 0, last = 0, min = 0, max = 0;
  const flush = () => { if (bucket >= 0) for (const index of [first, last, min, max]) keep.add(index); };
  for (let index = 0; index < points.length; index++) {
    const value = points[index].value;
    if (index > 0 && (value === null) !== (points[index - 1].value === null)) {
      keep.add(index - 1);
      keep.add(index);
    }
    if (value === null) continue;
    const next = Math.min(count - 1, Math.floor((points[index].startMs - start) / span * count));
    if (next !== bucket) {
      flush();
      bucket = next;
      first = min = max = index;
    }
    last = index;
    if (value < points[min].value!) min = index;
    if (value > points[max].value!) max = index;
  }
  flush();
  return [...keep].sort((a, b) => a - b).map((index) => points[index]);
}

/** Markers come from the submitted experiment; bounds come from the run's immutable series metadata. */
export function timelineRegions(warmupMs: number, measurementMs: number, faults: ExperimentFile["faults"], catalog: Catalog): TimelineRegion[] {
  const end = warmupMs + measurementMs;
  const units = catalog.types.flatMap((type) => type.params).find((param) => param.dimension === "DURATION")?.units ?? [];
  const regions: TimelineRegion[] = warmupMs > 0 ? [{ fromMs: 0, toMs: warmupMs, label: "Warmup", kind: "warmup" }] : [];
  for (const fault of faults) {
    const from = canonicalOf(fault.from, units), to = canonicalOf(fault.to, units);
    if (from === null || to === null || from >= end || to <= 0) continue;
    regions.push({ fromMs: Math.max(0, from), toMs: Math.min(end, to), label: `Fault: ${fault.target}`, kind: "fault" });
  }
  return regions;
}

export function windowAt(timeMs: number, windowMs: number, endMs: number): number {
  return Math.max(0, Math.min(Math.ceil(endMs / windowMs) - 1, Math.floor(timeMs / windowMs)));
}
