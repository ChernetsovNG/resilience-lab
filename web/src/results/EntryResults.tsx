import type { ReactNode } from "react";
import { messages, t } from "../i18n";
import { formatDuration, formatInterval, formatNumber, formatPercent } from "../i18n/format";
import { confidenceInterval } from "./confidence";
import { useConfidenceLevel } from "../layout/confidenceLevel";
import { failureMetric, hasUnreliableEntryInterval, sortedFailureReasons, type EntryMetrics } from "./entries";
import type { MetricSummary } from "../api/apiTypes";

/** Compact top three reasons; expansion compares this population's nonzero codes against the baseline. */
export function FailureReasons({ entry, reasons = sortedFailureReasons(entry), renderValue }: {
  entry: EntryMetrics | undefined; reasons?: readonly string[];
  renderValue?: (code: string, value: MetricSummary | undefined) => ReactNode;
}) {
  if (entry === undefined) return formatNumber(null);
  const nonzeroReasons = reasons.filter(code => (entry.failuresByReason[code]?.mean ?? 0) > 0);
  const leading = sortedFailureReasons(entry).slice(0, 3);
  const label = (code: string) => Object.hasOwn(messages, `messages.${code}`) ? t(`messages.${code}`) : code;
  const preview = leading.length === 0 ? t("results.entries.noFailures") : leading.map((code, index) =>
    <span key={code} title={code}>{index === 0 ? "" : t("editor.symbols.separator")}{label(code)} {formatPercent(entry.failuresByReason[code].mean)}</span>);
  return nonzeroReasons.length === 0 ? <span>{preview}</span> : <details className="entry-failures">
    <summary>{preview}</summary>
    <dl>{nonzeroReasons.map(code => <div key={code}><dt title={code}>{label(code)}</dt><dd>
      {renderValue === undefined ? formatPercent(failureMetric(entry, code)!.mean) : renderValue(code, failureMetric(entry, code))}
    </dd></div>)}</dl>
  </details>;
}

/** A client or request-type population, read directly from the saved aggregate and labeled as replication means. */
export function EntryResults({ entry, name, showFailures, showDegraded }: {
  entry: EntryMetrics | undefined; name: string; showFailures: boolean; showDegraded: boolean;
}) {
  const level = useConfidenceLevel();
  const value = (metric: MetricSummary | null | undefined, format: (value: number) => string) => {
    const interval = confidenceInterval(metric, level);
    return metric == null ? formatNumber(null) : <>{format(metric.mean)}{interval === null ? null :
      <span className={`summary-interval${metric.count < 5 ? " summary-interval--unreliable" : ""}`}>
        {t("results.intervalInParens", { interval: formatInterval(interval[0], interval[1], format, level) })}
      </span>}</>;
  };
  return <><table className="summary-table" aria-label={name}><tbody>
    <tr><th scope="row">{t("results.metrics.successRate")}</th><td>{value(entry?.successRate, formatPercent)}</td></tr>
    <tr><th scope="row">{t("results.metrics.p95LatencyMs")}</th><td>{value(entry?.p95LatencyMs, formatDuration)}</td></tr>
    <tr><th scope="row">{t("results.metrics.p99LatencyMs")}</th><td>{value(entry?.p99LatencyMs, formatDuration)}</td></tr>
    {showFailures ? <tr><th scope="row">{t("results.entries.failureReasons")}</th><td><FailureReasons entry={entry}
      renderValue={(_, metric) => value(metric, formatPercent)} /></td></tr> : null}
    {showDegraded ? <tr><th scope="row">{t("results.entries.degraded")}</th><td>{value(entry?.degradedRate, formatPercent)}</td></tr> : null}
  </tbody></table>{hasUnreliableEntryInterval(entry)
    ? <p className="summary-reliability-warning">{t("results.answer.lowReplications")}</p> : null}</>;
}
