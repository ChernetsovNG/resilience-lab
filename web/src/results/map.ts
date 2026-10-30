import { formatDuration, formatMultiplier, formatPercent } from "../i18n/format";
import type { MetricSummary, RunSummary } from "../api/apiTypes";

type Point = RunSummary["variants"][number]["points"][number];
export type MapMetric = "successRate" | "p95LatencyMs" | "p99LatencyMs" | "admittedAmplification" | "handlerUtilization";
export type MapValue = Pick<MetricSummary, "mean" | "stdDev"> & Partial<Pick<MetricSummary, "count">>;

/** The first axis is outermost. Positions, rather than coordinate equality, distinguish repeated values. */
export function gridCells(grid: RunSummary["grid"], points: Point[]) {
  const columns = grid[1]?.values.length ?? grid[0]?.values.length ?? 0;
  const count = grid.length === 2 ? grid[0].values.length * columns : columns;
  const byId = new Map(points.map((point) => [point.id, point]));
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`, row: Math.floor(index / columns), column: index % columns, point: byId.get(`p${index}`) ?? null,
  }));
}

/** Replication means and spread come from the artifact; utilization is the pooled busy/capacity ratio. */
export function mapMetric(aggregate: Point["aggregate"], metric: MapMetric, service: string): MapValue | null {
  if (metric === "admittedAmplification") return aggregate.services[service]?.admittedAmplification ?? null;
  if (metric === "handlerUtilization") {
    const totals = aggregate.services[service]?.totals;
    return totals == null || totals.handlerCapacityTimeMs === 0 ? null : { mean: totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs };
  }
  return aggregate[metric] ?? null;
}

export function formatMapValue(value: number, metric: MapMetric): string {
  if (metric === "successRate" || metric === "handlerUtilization") return formatPercent(value);
  return metric === "admittedAmplification" ? formatMultiplier(value) : formatDuration(value);
}
