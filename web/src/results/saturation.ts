import type { RunSummary, SaturationSummary } from "../api/apiTypes";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";

/** Formats recorded saturation insight without recalculating the rule, onset statistics or core ordering. */
export function formatSaturation(saturation: SaturationSummary, replications: number) {
  const { minimumDurationMs, handlerUtilizationThreshold, meanQueueLengthThreshold, queueRejectionsThreshold, ...additional } = saturation.rule;
  const extra = Object.entries(additional).map(([name, value]) => t("results.saturation.ruleParameter", {
    name, value: typeof value === "number" ? formatNumber(value, 20) : JSON.stringify(value),
  })).join(t("results.saturation.ruleSeparator"));
  return {
    firstNodes: saturation.firstNodes.length === 0 ? [t("results.saturation.none")] : saturation.firstNodes.map((first) =>
      t("results.saturation.first", {
        node: first.node, count: formatNumber(first.replicationCount), replications: formatNumber(replications),
        median: formatDuration(first.medianStartMs), min: formatNumber(first.minStartMs, 1), max: formatDuration(first.maxStartMs),
      })),
    withoutSaturation: t("results.saturation.without", { count: formatNumber(saturation.withoutSaturation), replications: formatNumber(replications) }),
    degradationPaths: saturation.replications.map(({ replication, degradationPath }) =>
      t("results.saturation.replicationPath", {
        replication: formatNumber(replication), path: degradationPath.length === 0 ? t("results.saturation.noPath")
          : degradationPath.map(({ node, startMs }) => t("results.saturation.nodeAt", { node, time: formatDuration(startMs) })).join(t("results.saturation.pathSeparator")),
      })),
    rule: t("results.saturation.rule", {
      utilization: formatPercent(handlerUtilizationThreshold), queue: formatNumber(meanQueueLengthThreshold, 20),
      duration: formatDuration(minimumDurationMs), rejections: formatNumber(queueRejectionsThreshold, 20),
    }) + (extra === "" ? "" : t("results.saturation.additionalRule", { rule: extra })),
  };
}

/** Summary-only capacity context; the two maxima may belong to different services. */
export function formatHeadroom(aggregate: RunSummary["variants"][number]["points"][number]["aggregate"]): string {
  const services = Object.entries(aggregate.services);
  const busiest = services.filter(([, { totals }]) => totals.handlerCapacityTimeMs > 0)
    .map(([service, { totals }]) => ({ service, value: totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs }))
    .sort((left, right) => right.value - left.value)[0];
  const longestQueue = services.filter(([, { totals }]) => totals.measurementMs > 0)
    .map(([service, { totals }]) => ({ service, value: totals.queueLengthIntegralMs / totals.measurementMs }))
    .sort((left, right) => right.value - left.value)[0];
  const atService = (entry: { service: string; value: number } | undefined, format: (value: number) => string) =>
    entry === undefined ? t("common.na") : t("results.answer.valueAtService", { service: entry.service, value: format(entry.value) });
  return t("results.answer.headroom", {
    utilization: atService(busiest, formatPercent),
    queue: atService(longestQueue, value => t("results.answer.queuedRequests", { value: formatNumber(value) })),
    p99: formatDuration(aggregate.pooledLatency.all?.p99Ms),
  });
}
