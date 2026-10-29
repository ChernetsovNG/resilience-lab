import { t } from "../i18n";
import { formatDuration, formatInterval, formatMultiplier, formatNumber, formatPercent } from "../i18n/format";
import { Fragment, type ReactNode } from "react";
import type { MetricSummary, RunSummary } from "../api/apiTypes";
import { SaturationInsight } from "../results/SaturationInsight";

/** Mean over replications with the Student 95% interval when there are at least two replications. */
function metric(summary: MetricSummary | null | undefined, format: (value: number) => string): ReactNode {
  if (summary == null) return formatNumber(null);
  const interval = summary.ci95Low == null || summary.ci95High == null ? null
    : <span className="summary-interval">{t("results.intervalInParens", { interval: formatInterval(summary.ci95Low, summary.ci95High, format) })}</span>;
  return <>{format(summary.mean)}{interval}</>;
}

interface SummaryTableProps {
  summary: RunSummary;
  activeVariantId?: string | null;
  selectedPointId?: string;
}

/** Metrics by variant and grid point (stage 1 design §6.3, Summary tab). */
export function SummaryTable({ summary, activeVariantId = null, selectedPointId = "p0" }: SummaryTableProps) {
  const rows = summary.variants.flatMap((variant) => variant.points.map((point) => ({ variant, point })));
  const services = [...new Set(rows.flatMap(({ point }) => Object.keys(point.aggregate.services)))].sort();
  return (
    <table className="summary-table" aria-label={t("results.summary.title")}>
      <colgroup>
        <col style={{ width: "9%" }} />
        <col style={{ width: "5%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "8%" }} />
        <col span={3} style={{ width: "12%" }} />
        <col style={{ width: "30%" }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">{t("results.variant")}</th>
          <th scope="col">{t("results.point")}</th>
          <th scope="col">{t("results.coordinates")}</th>
          <th scope="col">{t("results.replications")}</th>
          <th scope="col">{t("results.metrics.successRate")}</th>
          <th scope="col">{t("results.metrics.p95LatencyMs")}</th>
          <th scope="col">{t("results.metrics.p99LatencyMs")}</th>
          <th scope="col">{t("results.saturation.title")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ variant, point }) => {
          const className = [
            variant.id === activeVariantId ? "summary-row--active-variant" : null,
            point.id === selectedPointId ? "summary-row--selected-point" : null,
          ].filter(Boolean).join(" ");
          return (
            <Fragment key={`${variant.id}/${point.id}`}>
              <tr className={className}>
                <th scope="row">{variant.label}</th>
                <td>{point.id}</td>
                <td>{Object.entries(point.coordinates).map(([path, value]) => (
                  <div key={path}>{t("results.coordinate", { path, value: typeof value === "number" ? formatNumber(value) : typeof value === "string" ? value : JSON.stringify(value) })}</div>
                ))}</td>
                <td>{formatNumber(variant.replications)}</td>
                <td>{metric(point.aggregate.successRate, formatPercent)}</td>
                <td>{metric(point.aggregate.p95LatencyMs, formatDuration)}</td>
                <td>{metric(point.aggregate.p99LatencyMs, formatDuration)}</td>
                <td><SaturationInsight saturation={point.saturation} replications={variant.replications} /></td>
              </tr>
              {services.length === 0 ? null : <tr className="summary-services-row" aria-label={t("results.summary.serviceMetricsLabel", { variant: variant.id, point: point.id })}>
                <td colSpan={8}>
                  <details className="summary-services">
                    <summary>{t("results.summary.serviceMetrics", { count: formatNumber(services.length) })}</summary>
                    <table aria-label={t("results.summary.servicesFor", { variant: variant.label, point: point.id })}>
                      <thead><tr>
                        <th scope="col">{t("results.service")}</th>
                        <th scope="col">{t("results.metrics.admittedAmplification")}</th>
                        <th scope="col">{t("results.metrics.pooledUtilization")}</th>
                      </tr></thead>
                      <tbody>{services.map((service) => {
                        const metrics = point.aggregate.services[service];
                        const totals = metrics?.totals;
                        return <tr key={service}>
                          <th scope="row">{service}</th>
                          <td>{metric(metrics?.admittedAmplification, formatMultiplier)}</td>
                          <td>{totals == null || totals.handlerCapacityTimeMs === 0
                            ? formatNumber(null) : formatPercent(totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs)}</td>
                        </tr>;
                      })}</tbody>
                    </table>
                  </details>
                </td>
              </tr>}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
