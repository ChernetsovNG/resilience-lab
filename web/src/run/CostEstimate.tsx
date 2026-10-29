import { backendMessage } from "../i18n/backendMessage";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatSize } from "../i18n/format";
import type { ExperimentEstimate } from "../api/apiTypes";

/** API estimates, including uncertainty warnings; no local cost calculation. */
export function CostEstimate({ estimate }: { estimate: ExperimentEstimate }) {
  const values: [string, string][] = [
    [t("app.estimate.tasks"), formatNumber(estimate.tasks)], [t("app.estimate.workers"), formatNumber(estimate.workers)],
    [t("app.estimate.events"), formatNumber(estimate.expectedEvents)], [t("app.estimate.rows"), formatNumber(estimate.expectedRows)],
    [t("app.estimate.time"), formatDuration(estimate.estimatedSeconds, "s")],
    [t("app.estimate.uncompressedSize"), formatSize(estimate.estimatedUncompressedBytes)],
    [t("app.estimate.artifactSize"), formatSize(estimate.estimatedArtifactBytes)], [t("app.estimate.parts"), formatNumber(estimate.estimatedParts)],
  ];
  return <section className="cost-estimate" aria-label={t("app.estimate.cost")}>
    <strong>{t("app.estimate.cost")}</strong>
    <dl>{values.map(([label, value]) => <div key={label}>
      <dt>{label}</dt>
      <dd><output aria-label={label}>{value}</output></dd>
    </div>)}</dl>
    {estimate.warnings.length === 0 ? null : <ul>{estimate.warnings.map((warning) =>
      <li key={warning.code}>{backendMessage(warning)}</li>)}</ul>}
  </section>;
}
