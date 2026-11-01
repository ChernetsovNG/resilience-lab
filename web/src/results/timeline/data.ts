import { t } from "../../i18n";
import type { Catalog, ExperimentFile, ModelFile } from "../../api/apiTypes";
import { elementLabel } from "../../presentation/labels";
import { canonicalOf } from "../../workspace/quantities";
export type TimelineMetricValues = { startMs: number; durationMs: number } & Record<string, number | null>;

export interface TimelinePoint { window: number; startMs: number; value: number | null }
export interface TimelineRegion { fromMs: number; toMs: number; label: string; kind: "warmup" | "fault" }

/** Recorded replica bounds retain both extrema and missing-value gaps at the chart's pixel budget. */
export function replicaBand(windows: readonly TimelineMetricValues[], bounds: readonly [string, string], scale: number, pixels: number) {
  const ranges = windows.map(window => {
    const min = window[bounds[0]], max = window[bounds[1]];
    return min == null || max == null ? null : [min * scale, max * scale] as [number, number];
  });
  const points: { window: number; startMs: number; range: [number, number] | null }[] = [];
  for (const [window, metrics] of windows.entries()) {
    const range = ranges[window];
    points.push({ window, startMs: metrics.startMs, range });
    if (window === windows.length - 1 || (range !== null && ranges[window + 1] === null)) {
      points.push({ window, startMs: metrics.startMs + metrics.durationMs, range });
    }
  }
  const key = (point: { window: number; startMs: number }) => `${point.window}:${point.startMs}`;
  const keep = new Set([0, 1].flatMap(bound => downsample(points.map(point => ({ ...point,
    value: point.range?.[bound] ?? null })), pixels).map(key)));
  return points.filter(point => keep.has(key(point)));
}

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
export function timelineRegions(warmupMs: number, measurementMs: number, faults: ExperimentFile["faults"], catalog: Catalog, model?: ModelFile): TimelineRegion[] {
  const end = warmupMs + measurementMs;
  const units = catalog.types.flatMap((type) => type.params).find((param) => param.dimension === "DURATION")?.units ?? [];
  const regions: TimelineRegion[] = warmupMs > 0 ? [{ fromMs: 0, toMs: warmupMs, label: t("results.assumptions.warmup"), kind: "warmup" }] : [];
  for (const fault of faults) {
    if (fault.from == null || fault.to == null) continue;
    const from = canonicalOf(fault.from, units), to = canonicalOf(fault.to, units);
    if (from === null || to === null || from >= end || to <= 0) continue;
    regions.push({ fromMs: Math.max(0, from), toMs: Math.min(end, to), label: t("results.timeline.fault", { target: elementLabel(fault.target, model) }), kind: "fault" });
  }
  return regions;
}

export function windowAt(timeMs: number, windowMs: number, endMs: number): number {
  return Math.max(0, Math.min(Math.ceil(endMs / windowMs) - 1, Math.floor(timeMs / windowMs)));
}
