import type { RunSummary, SaturationSummary } from "../api/apiTypes";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";

/** Formats recorded saturation insight without recalculating the rule, onset statistics or core ordering. */
export function formatSaturation(saturation: SaturationSummary, replications: number) {
  const { minimumDurationMs, utilizationThreshold, meanQueueLengthThreshold, rejectionsThreshold, ...additional } = saturation.rule;
  const extra = Object.entries(additional).map(([name, value]) => t("results.saturation.ruleParameter", {
    name, value: typeof value === "number" ? formatNumber(value, 20) : JSON.stringify(value),
  })).join(t("results.saturation.ruleSeparator"));
  return {
    firstNodes: saturation.firstNodes.length === 0 ? [t("results.saturation.none")] : saturation.firstNodes.map((first) =>
      t("results.saturation.first", {
        node: backendMessage(first.label), count: formatNumber(first.replicationCount), replications: formatNumber(replications),
        median: formatDuration(first.medianStartMs), min: formatNumber(first.minStartMs, 1), max: formatDuration(first.maxStartMs),
      })),
    withoutSaturation: t("results.saturation.without", { count: formatNumber(saturation.withoutSaturation), replications: formatNumber(replications) }),
    degradationPaths: saturation.replications.map(({ replication, degradationPath }) =>
      t("results.saturation.replicationPath", {
        replication: formatNumber(replication), path: degradationPath.length === 0 ? t("results.saturation.noPath")
          : degradationPath.map(({ label, startMs }) => t("results.saturation.nodeAt", { node: backendMessage(label), time: formatDuration(startMs) })).join(t("results.saturation.pathSeparator")),
      })),
    rule: t("results.saturation.rule", {
      utilization: formatPercent(utilizationThreshold), queue: formatNumber(meanQueueLengthThreshold, 20),
      duration: formatDuration(minimumDurationMs), rejections: formatNumber(rejectionsThreshold, 20),
    }) + (extra === "" ? "" : t("results.saturation.additionalRule", { rule: extra })),
  };
}

/** Formats the core's two independent maxima without recalculating them from aggregate rows. */
export function formatHeadroom(
  aggregate: RunSummary["variants"][number]["points"][number]["aggregate"],
  headroom: RunSummary["variants"][number]["points"][number]["headroom"],
): string {
  const atResource = (entry: typeof headroom.utilization, format: (value: number) => string) =>
    entry == null ? t("common.na") : t("results.answer.valueAtService", { service: backendMessage(entry.label), value: format(entry.value) });
  return t("results.answer.headroom", {
    utilization: atResource(headroom.utilization, formatPercent),
    queue: atResource(headroom.meanQueueLength, value => t("results.answer.queuedRequests", { value: formatNumber(value) })),
    p99: formatDuration(aggregate.pooledLatency.all?.p99Ms),
  });
}
