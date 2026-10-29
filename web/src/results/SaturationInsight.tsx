import { t } from "../i18n";
import type { SaturationSummary } from "../api/apiTypes";
import { formatSaturation } from "./saturation";

/** The summary's conclusion and per-replication evidence for one variant and grid point. */
export function SaturationInsight({ saturation, replications }: { saturation: SaturationSummary; replications: number }) {
  const text = formatSaturation(saturation, replications);
  return (
    <div className="saturation-insight">
      {text.firstNodes.map((node, index) => <p key={index}>{node}</p>)}
      <p>{text.withoutSaturation}</p>
      <details>
        <summary>{t("results.saturation.degradationPaths")}</summary>
        <ul>{text.degradationPaths.map((path, index) => <li key={index}>{path}</li>)}</ul>
      </details>
      <p className="saturation-rule">{text.rule}</p>
    </div>
  );
}
