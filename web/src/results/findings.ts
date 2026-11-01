import type { Catalog, MetricSummary, ModelFile, RunSummary, SaturationSummary } from "../api/apiTypes";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";
import { canonicalOf } from "../workspace/quantities";
import { confidenceInterval, type ConfidenceLevel } from "./confidence";

type Aggregate = RunSummary["variants"][number]["points"][number]["aggregate"];
type Observation = { label: string; metric: MetricSummary | null | undefined; aggregate?: Aggregate };
const quotedVariant = (variant: string) => t("results.answer.variantName", { variant });

/** Each variant's weakest saved population, at least five percentage points below its total. */
export function worstSliceConclusions(items: readonly { label: string; aggregate: Aggregate }[]): string[] {
  const groups = new Map<string, { kind: "clients" | "classes"; id: string; values: string[] }>();
  for (const { label, aggregate: { entries } } of items) {
    const total = entries.total.successRate?.mean;
    if (total == null || !Number.isFinite(total)) continue;
    let worst: { kind: "clients" | "classes"; id: string; rate: number } | undefined;
    for (const kind of ["classes", "clients"] as const) for (const id of Object.keys(entries[kind]).sort()) {
      const rate = entries[kind][id].successRate?.mean;
      if (rate == null || !Number.isFinite(rate) || total - rate + Number.EPSILON < 0.05) continue;
      if (worst === undefined || rate < worst.rate) worst = { kind, id, rate };
    }
    if (worst === undefined) continue;
    const key = JSON.stringify([worst.kind, worst.id]);
    const group = groups.get(key) ?? { kind: worst.kind, id: worst.id, values: [] };
    group.values.push(t("results.answer.sliceValue", { value: formatPercent(worst.rate), variant: quotedVariant(label) }));
    groups.set(key, group);
  }
  return [...groups.values()].map(group => t(group.kind === "classes" ? "results.answer.worstRequestType" : "results.answer.worstClient", {
    id: group.id, variants: group.values.join(", "),
  }));
}

/** Entry shares describe original requests; retry-budget counters describe attempts across replications. */
function comparisonCost(aggregate: Aggregate | undefined): string {
  if (aggregate === undefined) return "";
  const entry = aggregate.entries.total;
  const parts: string[] = [];
  const rejected = (entry.failuresByReason.rateLimited?.mean ?? 0) + (entry.failuresByReason.circuitOpen?.mean ?? 0);
  if (rejected > 0) {
    if (entry.successRate != null) parts.push(t("results.answer.costSuccess", { value: formatPercent(entry.successRate.mean) }));
    parts.push(t("results.answer.costRejected", { value: formatPercent(rejected) }));
    const clients = Object.entries(aggregate.entries.clients).map(([id, metrics]) => ({ id, rate: metrics.successRate?.mean }))
      .filter((client): client is { id: string; rate: number } => client.rate != null && Number.isFinite(client.rate))
      .sort((a, b) => a.rate - b.rate || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (clients[0] !== undefined && clients[0].rate < 1) parts.push(t("results.answer.costClient", {
      id: clients[0].id, value: formatPercent(1 - clients[0].rate),
    }));
  }
  if ((entry.degradedRate?.mean ?? 0) > 0) parts.push(t("results.answer.costFallback", { value: formatPercent(entry.degradedRate!.mean) }));
  const connectionGroups = new Set(aggregate.groups.filter(group => group.kind === "CONNECTION").map(group => group.id));
  const denied = Object.entries(aggregate.connections).filter(([id]) => !connectionGroups.has(id))
    .reduce((sum, [, connection]) => sum + connection.totals.retriesDenied, 0);
  if (denied > 0) parts.push(t("results.answer.costRetryBudget", { count: formatNumber(denied) }));
  return parts.join("; ");
}

/** Rank observed means only; interval overlap describes uncertainty, not statistical significance. */
export function comparisonConclusion(observations: readonly Observation[], criterion: "successRate" | "p99LatencyMs", level: ConfidenceLevel): string {
  const available = observations.filter((item): item is Observation & { metric: MetricSummary } =>
    item.metric != null && Number.isFinite(item.metric.mean));
  if (available.length === 0) return t(criterion === "successRate" ? "results.answer.noSuccess" : "results.answer.noLatency");
  const best = available.reduce((best, item) => (criterion === "successRate" ? item.metric.mean > best.metric.mean
    : item.metric.mean < best.metric.mean) ? item : best);
  const value = criterion === "successRate" ? formatPercent(best.metric.mean) : formatDuration(best.metric.mean);
  const leaders = available.filter(item => item.metric.mean === best.metric.mean);
  const costs = leaders.flatMap(leader => {
    const cost = comparisonCost(leader.aggregate);
    return cost === "" ? [] : [leaders.length === 1 ? cost : t("results.answer.costForVariant", { variant: quotedVariant(leader.label), cost })];
  });
  const cost = costs.length === 0 ? "" : `; ${costs.join("; ")}`;
  if (observations.length === 1) return t(criterion === "successRate" ? "results.answer.singleSuccess" : "results.answer.singleLatency", { value, cost });
  const intervals = leaders.map(leader => confidenceInterval(leader.metric, level));
  const overlap: string[] = [], separate: string[] = [], unknown: string[] = [];
  for (const other of observations) {
    if (leaders.some(leader => leader === other)) continue;
    const otherInterval = confidenceInterval(other.metric, level);
    if (otherInterval === null || intervals.some(interval => interval === null)) unknown.push(quotedVariant(other.label));
    else if (intervals.every(interval => interval !== null && (interval[1] < otherInterval[0] || otherInterval[1] < interval[0]))) separate.push(quotedVariant(other.label));
    else overlap.push(quotedVariant(other.label));
  }
  const allOverlap = observations.every(other => {
    const otherInterval = confidenceInterval(other.metric, level);
    return otherInterval !== null && intervals.every(interval => interval !== null
      && interval[1] >= otherInterval[0] && otherInterval[1] >= interval[0]);
  });
  if (allOverlap) return t(criterion === "successRate" ? "results.answer.noClearSuccess" : "results.answer.noClearLatency", {
    variants: leaders.map(item => quotedVariant(item.label)).join(", "), value, cost,
  });
  const comparison = [
    overlap.length === 0 ? null : t("results.answer.withinSpread", { variants: overlap.join(", ") }),
    separate.length === 0 ? null : t("results.answer.separateFrom", { variants: separate.join(", ") }),
    unknown.length === 0 ? null : t("results.answer.unknownIntervals", { variants: unknown.join(", ") }),
  ].filter(value => value !== null).join("; ") || (leaders.length === 1 ? t("results.answer.onlyVariant")
    : t(intervals.some(interval => interval === null) ? "results.answer.unknownIntervals" : "results.answer.withinSpread", {
      variants: leaders.map(item => quotedVariant(item.label)).join(", "),
    }));
  return t(criterion === "successRate" ? "results.answer.bestSuccess" : "results.answer.bestLatency", {
    variants: leaders.map(item => quotedVariant(item.label)).join(", "),
    value, cost, comparison,
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
    variants: allVariants && group.length === items.length && items.length > 1 ? t("results.answer.allVariants") : group.map(item => quotedVariant(item.label)).join(", "),
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
