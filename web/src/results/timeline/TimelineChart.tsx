import { t } from "../../i18n";
import { formatNumber, formatPercent } from "../../i18n/format";
import { useMemo } from "react";
import { Chart } from "../chart/Chart";
import { chartColors } from "../chart/palette";
import type { ChartOverlay, ChartSeries } from "../chart/types";
import { replicaBand, type TimelineRegion, type TimelineMetricValues } from "./data";
import type { PolicyState } from "../policyState";

export interface TimelineLine {
  id: string;
  label: string;
  elementId: string;
  variantId: string;
  replication: number;
  metric: keyof TimelineMetricValues;
  scale: number;
  color: string;
  comparison: boolean;
  windows: readonly TimelineMetricValues[];
  range?: readonly [string, string];
}

export interface TimelineThreshold {
  id: string;
  label: string;
  value: number;
  comparison: boolean;
}

export interface TimelineStateBand {
  id: string;
  label: string;
  state: PolicyState;
  copies: number;
  windows: readonly { startMs: number; durationMs: number; share: number | null }[];
}

interface TimelineChartProps {
  title: string;
  unit: string;
  lines: TimelineLine[];
  bands?: TimelineStateBand[];
  regions: TimelineRegion[];
  thresholds?: TimelineThreshold[];
  endMs: number;
  windowMs: number;
  axisId: string;
}

/** Numeric time axes stay aligned across independently sampled lines; readouts always use original windows. */
export function TimelineChart({ title, unit, lines, bands = [], regions, thresholds = [], endMs, windowMs, axisId }: TimelineChartProps) {
  const series = useMemo((): ChartSeries[] => lines.map(line => ({
    id: line.id, label: line.label, elementId: line.elementId, outputId: line.metric,
    variantId: line.variantId, replication: line.replication,
    color: line.color, dash: line.comparison ? "dashed" : "solid", marker: unit === "ms" ? line.comparison ? "square" : "circle" : undefined,
    // Close each defined segment at the end of its last window, including isolated values before a gap.
    points: line.windows.map((metrics, window) => ({ window, x: metrics.startMs, endX: metrics.startMs + metrics.durationMs,
      value: metrics[line.metric] == null ? null : metrics[line.metric]! * line.scale })),
    range: line.range === undefined ? undefined : replicaBand(line.windows, line.range, line.scale, Infinity)
      .map(point => ({ window: point.window, x: point.startMs, range: point.range })),
  })), [lines, unit]);
  const overlays: ChartOverlay[] = [
    ...regions.map((region, index): ChartOverlay => ({ kind: "region", id: region.kind + ":" + index, role: region.kind,
      from: region.fromMs, to: region.toMs, label: region.label })),
    ...thresholds.map((threshold): ChartOverlay => ({ kind: "threshold", id: threshold.id, value: threshold.value,
      label: threshold.label, dash: threshold.comparison ? "dashed" : undefined })),
    ...bands.map((band): ChartOverlay => ({ kind: "state", id: band.id, label: band.label, color: chartColors[band.state],
      points: band.windows.map((window, index) => ({ window: index, x: window.startMs, endX: window.startMs + window.durationMs, value: window.share,
        description: window.share === null ? t("results.timeline.noValue") : t("results.timeline.policyWindow", {
          state: t("results.timeline.policyValue." + band.state), share: formatPercent(window.share),
        }) + (band.state === "circuitOpenShare" && band.copies > 1 ? t("results.timeline.policyCallers", { copies: formatNumber(band.copies) }) : ""),
      })),
    })),
  ];
  return <Chart className="timeline-chart" description={{ title, unit, series, overlays, colorBy: "element", preset: "full",
    x: { kind: "time", id: axisId, domain: [0, endMs], windowMs, label: t(endMs >= 1000 ? "results.timeline.timeAxisSeconds" : "results.timeline.timeAxis") },
    note: unit === "ms" ? t("results.timeline.latencyNote") : undefined,
  }} />;
}
