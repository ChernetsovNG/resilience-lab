import { useId } from "react";
import { HelpHint } from "../help/HelpHint";
import { backendMessage } from "../i18n/backendMessage";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatSize } from "../i18n/format";
import type { ExperimentEstimate } from "../api/apiTypes";

/** API estimates, including uncertainty warnings; no local cost calculation. */
export function CostEstimate({ estimate }: { estimate: ExperimentEstimate }) {
  const id = useId();
  const values: [string, string][] = [
    ["tasks", formatNumber(estimate.tasks)], ["workers", formatNumber(estimate.workers)],
    ["events", formatNumber(estimate.expectedEvents)], ["rows", formatNumber(estimate.expectedRows)],
    ["time", formatDuration(estimate.estimatedSeconds, "s")],
    ["uncompressedSize", formatSize(estimate.estimatedUncompressedBytes)],
    ["artifactSize", formatSize(estimate.estimatedArtifactBytes)], ["parts", formatNumber(estimate.estimatedParts)],
  ];
  return <section className="cost-estimate" aria-label={t("app.estimate.cost")}>
    <strong>{t("app.estimate.cost")}</strong>
    <dl>{values.map(([field, value]) => {
      const label = t("app.estimate." + field);
      const hintId = id + "-" + field;
      return <div key={field}>
        <dt>{label} <HelpHint id={hintId} label={label}>{t(field === "tasks" ? "help.tasks" : "help.estimate." + field)}</HelpHint></dt>
        <dd><output aria-label={label} aria-describedby={hintId}>{value}</output></dd>
      </div>;
    })}</dl>
    {estimate.warnings.length === 0 ? null : <ul>{estimate.warnings.map((warning) =>
      <li key={warning.code}>{backendMessage(warning)}</li>)}</ul>}
  </section>;
}
