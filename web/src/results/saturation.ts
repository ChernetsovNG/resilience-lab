import type { SaturationSummary } from "../api/apiTypes";
import { t } from "../i18n";
import { formatDuration, formatNumber } from "../i18n/format";

/** Formats recorded saturation insight without recalculating the rule, onset statistics or core ordering. */
export function formatSaturation(saturation: SaturationSummary, replications: number) {
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
    rule: t("results.saturation.rule", { rule: Object.entries(saturation.rule).map(([name, value]) =>
      t("results.saturation.ruleParameter", { name, value: typeof value === "number" ? formatNumber(value, 20) : JSON.stringify(value) })).join(t("results.saturation.ruleSeparator")) }),
  };
}
