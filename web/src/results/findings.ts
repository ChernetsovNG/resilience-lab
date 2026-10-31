import type { Catalog, MetricSummary, ModelFile, SaturationSummary } from "../api/apiTypes";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { formatDuration, formatPercent } from "../i18n/format";
import { canonicalOf } from "../workspace/quantities";
import { confidenceInterval, type ConfidenceLevel } from "./confidence";

type Observation = { label: string; metric: MetricSummary | null | undefined };

/** Rank observed means only; interval overlap describes uncertainty, not statistical significance. */
export function comparisonConclusion(observations: readonly Observation[], criterion: "successRate" | "p99LatencyMs", level: ConfidenceLevel): string {
  const available = observations.filter((item): item is Observation & { metric: MetricSummary } =>
    item.metric != null && Number.isFinite(item.metric.mean));
  if (available.length === 0) return t(criterion === "successRate" ? "results.answer.noSuccess" : "results.answer.noLatency");
  const best = available.reduce((best, item) => (criterion === "successRate" ? item.metric.mean > best.metric.mean
    : item.metric.mean < best.metric.mean) ? item : best);
  const leaders = available.filter(item => item.metric.mean === best.metric.mean);
  const intervals = leaders.map(leader => confidenceInterval(leader.metric, level));
  const overlap: string[] = [], separate: string[] = [], unknown: string[] = [];
  for (const other of observations) {
    if (leaders.some(leader => leader === other)) continue;
    const otherInterval = confidenceInterval(other.metric, level);
    if (otherInterval === null || intervals.some(interval => interval === null)) unknown.push(other.label);
    else if (intervals.every(interval => interval !== null && (interval[1] < otherInterval[0] || otherInterval[1] < interval[0]))) separate.push(other.label);
    else overlap.push(other.label);
  }
  const comparison = [
    overlap.length === 0 ? null : t("results.answer.withinSpread", { variants: overlap.join(", ") }),
    separate.length === 0 ? null : t("results.answer.separateFrom", { variants: separate.join(", ") }),
    unknown.length === 0 ? null : t("results.answer.unknownIntervals", { variants: unknown.join(", ") }),
  ].filter(value => value !== null).join("; ") || (leaders.length === 1 ? t("results.answer.onlyVariant")
    : t(intervals.some(interval => interval === null) ? "results.answer.unknownIntervals" : "results.answer.withinSpread", {
      variants: leaders.map(item => item.label).join(", "),
    }));
  return t(criterion === "successRate" ? "results.answer.bestSuccess" : "results.answer.bestLatency", {
    variants: leaders.map(item => item.label).join(", "),
    value: criterion === "successRate" ? formatPercent(best.metric.mean) : formatDuration(best.metric.mean), comparison,
  });
}

/** Share only the first-resource conclusion; onset times and counts remain in the selected variant's evidence. */
export function saturationConclusions(items: readonly { label: string; saturation: SaturationSummary }[], allVariants: boolean): string[] {
  const groups = new Map<string, typeof items[number][]>();
  for (const item of items) {
    const key = JSON.stringify(item.saturation.firstNodes.map(first => [first.node, first.slotPool]).sort());
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map(group => t(group[0].saturation.firstNodes.length === 0
    ? "results.answer.variantUnsaturated" : "results.answer.variantSaturated", {
    variants: allVariants && group.length === items.length && items.length > 1 ? t("results.answer.allVariants") : group.map(item => item.label).join(", "),
    resources: group[0].saturation.firstNodes.map(first => backendMessage(first.label)).join(", "),
  }));
}

export interface LatencyLimit { kind: "timeout" | "deadline"; durationMs: number; source: string }

/** Read configured limits from the effective saved model, after variant and grid overrides. */
export function latencyLimits(model: ModelFile, catalog: Catalog): LatencyLimit[] {
  const candidates = [
    ...Object.entries(model.blocks).filter(([, block]) => block.type === "client").map(([id, block]) =>
      ({ ...block, id, kind: "deadline" as const })),
    ...model.connections.filter(connection => connection.type === "call").map(connection =>
      ({ ...connection, kind: "timeout" as const })),
  ];
  return candidates.flatMap(candidate => {
    const descriptor = catalog.types.find(type => type.id === candidate.type)?.params.find(param => param.name === candidate.kind);
    const value = candidate.params[candidate.kind] ?? descriptor?.default;
    const durationMs = typeof value === "string" && descriptor !== undefined ? canonicalOf(value, descriptor.units) : null;
    return durationMs === null || durationMs <= 0 ? [] : [{ kind: candidate.kind, durationMs, source: candidate.id }];
  });
}

/** Match each replication's quantile within the recorded sketch profile's 0.78125% representation bound. */
export function latencyLimitMatch(metric: MetricSummary | null | undefined, limits: readonly LatencyLimit[]): string | null {
  if (metric == null || metric.count < 1) return null;
  const matches = limits.filter(limit => [metric.mean, metric.min, metric.max].every(value =>
    Number.isFinite(value) && Math.abs(value - limit.durationMs) <= limit.durationMs / 128));
  return matches.length === 0 ? null : matches.map(limit => t(limit.kind === "timeout" ? "results.answer.timeoutCeiling" : "results.answer.deadlineCeiling", {
    duration: formatDuration(limit.durationMs), source: limit.source,
  })).join("; ");
}
