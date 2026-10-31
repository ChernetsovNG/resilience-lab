import type { RunSummary, SaturationSummary } from "../api/apiTypes";
import type { CourseFault } from "../experiment/course";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";

/** Formats recorded saturation insight without recalculating the rule, onset statistics or core ordering. */
export function formatSaturation(saturation: SaturationSummary, replications: number,
  faults: readonly Pick<CourseFault, "label" | "fromMs" | "toMs">[] = [], windowMs = 0) {
  const { minimumDurationMs, utilizationThreshold, meanQueueLengthThreshold, rejectionsThreshold, ...additional } = saturation.rule;
  const extra = Object.entries(additional).map(([name, value]) => t("results.saturation.ruleParameter", {
    name, value: typeof value === "number" ? formatNumber(value, 20) : JSON.stringify(value),
  })).join(t("results.saturation.ruleSeparator"));
  const paths = new Map<string, typeof saturation.replications>();
  for (const replication of saturation.replications) {
    const key = JSON.stringify(replication.degradationPath.map(step => [step.node, step.slotPool]));
    const group = paths.get(key) ?? [];
    group.push(replication);
    paths.set(key, group);
  }
  const causes = faults.flatMap(fault => {
    if (fault.fromMs === null || fault.toMs === null) return [];
    const during = saturation.firstNodes.some(first => first.medianStartMs >= fault.fromMs! && first.medianStartMs < fault.toMs!);
    const after = saturation.firstNodes.some(first => first.medianStartMs >= fault.toMs! && first.medianStartMs < fault.toMs! + windowMs);
    return during || after ? [t(during ? "results.saturation.duringFault" : "results.saturation.afterFault", { fault: fault.label })] : [];
  });
  return {
    firstNodes: saturation.firstNodes.length === 0 ? [t("results.saturation.none")] : saturation.firstNodes.map((first) =>
      t("results.saturation.first", {
        node: backendMessage(first.label), count: formatNumber(first.replicationCount), replications: formatNumber(replications),
        median: formatDuration(first.medianStartMs), min: formatDuration(first.minStartMs), max: formatDuration(first.maxStartMs),
      })),
    withoutSaturation: t("results.saturation.without", { count: formatNumber(saturation.withoutSaturation), replications: formatNumber(replications) }),
    causes,
    degradationPaths: [...paths.values()].map(group => t("results.saturation.groupedPath", {
      count: formatNumber(group.length), replications: formatNumber(replications),
      path: group[0].degradationPath.length === 0 ? t("results.saturation.noPath")
        : group[0].degradationPath.map(({ label }, index) => {
          const starts = group.map(replication => replication.degradationPath[index].startMs);
          const min = Math.min(...starts), max = Math.max(...starts);
          return t("results.saturation.nodeAt", { node: backendMessage(label), time: min === max ? formatDuration(min)
            : t("results.saturation.timeRange", { min: formatDuration(min), max: formatDuration(max) }) });
        }).join(t("results.saturation.pathSeparator")),
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
  return t("results.answer.headroom", {
    utilization: formatPercent(headroom.utilization?.value),
    utilizationResource: headroom.utilization == null ? t("common.na") : backendMessage(headroom.utilization.label),
    queue: formatNumber(headroom.meanQueueLength?.value),
    queueResource: headroom.meanQueueLength == null ? t("common.na") : backendMessage(headroom.meanQueueLength.label),
    p99: formatDuration(aggregate.entries.total.pooledLatency.all?.p99Ms),
  });
}
