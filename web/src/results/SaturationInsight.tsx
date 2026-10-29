import { t } from "../i18n";
import type { SaturationSummary } from "../api/apiTypes";
import { formatSaturation } from "./saturation";

/** The summary's conclusion and per-replication evidence for one variant and grid point. */
export function SaturationInsight({ saturation, replications, headroom }: {
  saturation: SaturationSummary; replications: number; headroom?: string | null;
}) {
  const text = formatSaturation(saturation, replications);
  return (
    <div className="saturation-insight">
      {text.firstNodes.map((node, index) => <p key={index}>{node}</p>)}
      <p>{text.withoutSaturation}</p>
      {headroom == null ? null : <p>{headroom}</p>}
      <details>
        <summary>{t("results.saturation.degradationPaths")}</summary>
        <ul>{text.degradationPaths.map((path, index) => <li key={index}>{path}</li>)}</ul>
      </details>
      <details className="saturation-rule">
        <summary>{t("results.saturation.howDetected")}</summary>
        <p>{text.rule}</p>
      </details>
    </div>
  );
}
