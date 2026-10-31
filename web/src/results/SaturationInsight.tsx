import { formatNumber } from "../i18n/format";
import { t } from "../i18n";
import type { SaturationSummary } from "../api/apiTypes";
import type { CourseFault } from "../experiment/course";
import { formatSaturation } from "./saturation";

/** The summary's conclusion and per-replication evidence for one variant and grid point. */
export function SaturationInsight({ saturation, replications, headroom, faults = [], windowMs = 0, onElement }: {
  saturation: SaturationSummary; replications: number; headroom?: string | null;
  faults?: readonly CourseFault[]; windowMs?: number; onElement?: (id: string) => void;
}) {
  const text = formatSaturation(saturation, replications, faults, windowMs);
  return (
    <div className="saturation-insight">
      {text.firstNodes.map((node, index) => <p key={index}>{onElement === undefined || saturation.firstNodes[index] === undefined ? node : <button type="button" className="result-element-link"
        onClick={() => onElement(saturation.firstNodes[index].node)}>{node}</button>}</p>)}
      {text.causes.map((cause, index) => <p key={index}>{cause}</p>)}
      <p>{text.withoutSaturation}</p>
      {headroom == null ? null : <p>{headroom}</p>}
      <details>
        <summary>{t("results.saturation.degradationPaths")}</summary>
        <ul>{text.degradationPaths.slice(0, 3).map((path, index) => <li key={index}>{path}</li>)}</ul>
        {text.degradationPaths.length <= 3 ? null : <details>
          <summary>{t("results.saturation.morePaths", { count: formatNumber(text.degradationPaths.length - 3) })}</summary>
          <ul>{text.degradationPaths.slice(3).map((path, index) => <li key={index}>{path}</li>)}</ul>
        </details>}
      </details>
      <details className="saturation-rule">
        <summary>{t("results.saturation.howDetected")}</summary>
        <p>{text.rule}</p>
      </details>
    </div>
  );
}
