import { Fragment, type ReactNode } from "react";
import type { MetricSummary, RunSummary } from "../api/apiTypes";
import { SaturationInsight } from "../results/SaturationInsight";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const millis = (value: number) => `${value.toFixed(1)} ms`;
const times = (value: number) => `${value.toFixed(2)}×`;

/** Mean over replications with the Student 95% interval when there are at least two replications. */
function metric(summary: MetricSummary | null | undefined, format: (value: number) => string): ReactNode {
  if (summary == null) return "n/a";
  const interval = summary.ci95Low == null || summary.ci95High == null ? null
    : <span className="summary-interval">{` (95% CI ${format(summary.ci95Low)}–${format(summary.ci95High)})`}</span>;
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
    <table className="summary-table" aria-label="Summary">
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
          <th scope="col">Variant</th>
          <th scope="col">Point</th>
          <th scope="col">Coordinates</th>
          <th scope="col">Replications</th>
          <th scope="col">Success rate</th>
          <th scope="col">p95 latency</th>
          <th scope="col">p99 latency</th>
          <th scope="col">Saturation insight</th>
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
                  <div key={path}>{path} = {typeof value === "string" ? value : JSON.stringify(value)}</div>
                ))}</td>
                <td>{variant.replications}</td>
                <td>{metric(point.aggregate.successRate, percent)}</td>
                <td>{metric(point.aggregate.p95LatencyMs, millis)}</td>
                <td>{metric(point.aggregate.p99LatencyMs, millis)}</td>
                <td><SaturationInsight saturation={point.saturation} replications={variant.replications} /></td>
              </tr>
              {services.length === 0 ? null : <tr className="summary-services-row" aria-label={`${variant.id}/${point.id} service metrics`}>
                <td colSpan={8}>
                  <details className="summary-services">
                    <summary>Service metrics ({services.length})</summary>
                    <table aria-label={`Services for ${variant.label} ${point.id}`}>
                      <thead><tr>
                        <th scope="col">Service</th>
                        <th scope="col">Admitted amplification</th>
                        <th scope="col">Handler utilization (pooled busy/capacity)</th>
                      </tr></thead>
                      <tbody>{services.map((service) => {
                        const metrics = point.aggregate.services[service];
                        const totals = metrics?.totals;
                        return <tr key={service}>
                          <th scope="row">{service}</th>
                          <td>{metric(metrics?.admittedAmplification, times)}</td>
                          <td>{totals == null || totals.handlerCapacityTimeMs === 0
                            ? "n/a" : percent(totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs)}</td>
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
