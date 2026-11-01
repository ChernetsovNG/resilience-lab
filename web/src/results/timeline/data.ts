import { t } from "../../i18n";
import { sampleBand, samplePoints } from "../chart/data";
import type { Catalog, ExperimentFile, ModelFile } from "../../api/apiTypes";
import { elementLabel } from "../../presentation/labels";
import { canonicalOf } from "../../workspace/quantities";
export { windowAt } from "../chart/data";
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
  return sampleBand(points, pixels, point => point.startMs);
}

/** First, last, min and max per screen pixel, plus both edges of every missing-value gap. */
export function downsample(points: readonly TimelinePoint[], pixels: number): TimelinePoint[] {
  return samplePoints(points, pixels, point => point.startMs);
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
