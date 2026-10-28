import { Fragment } from "react";
import type { MetricSummary, RunSummary } from "../api/apiTypes";
import { SaturationInsight } from "../results/SaturationInsight";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const millis = (value: number) => `${value.toFixed(1)} ms`;
const times = (value: number) => `${value.toFixed(2)}×`;

/** Mean over replications with the Student 95% interval when there are at least two replications. */
function metric(summary: MetricSummary | null | undefined, format: (value: number) => string): string {
  if (summary == null) return "n/a";
  const interval =
    summary.ci95Low == null || summary.ci95High == null ? "" : ` (95% CI ${format(summary.ci95Low)}–${format(summary.ci95High)})`;
  return format(summary.mean) + interval;
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
      <thead>
        <tr>
          <th scope="col">Variant</th>
          <th scope="col">Point</th>
          <th scope="col">Coordinates</th>
          <th scope="col">Replications</th>
          <th scope="col">Success rate</th>
          <th scope="col">p95 latency</th>
          <th scope="col">p99 latency</th>
          {services.map((service) => (
            <Fragment key={service}>
              <th scope="col">{service} admitted ×</th>
              <th scope="col">{service} handler utilization (busy/capacity)</th>
            </Fragment>
          ))}
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
            <tr key={`${variant.id}/${point.id}`} className={className}>
              <th scope="row">{variant.label}</th>
              <td>{point.id}</td>
              <td>{Object.entries(point.coordinates).map(([path, value]) => (
                <div key={path}>{path} = {typeof value === "string" ? value : JSON.stringify(value)}</div>
              ))}</td>
              <td>{variant.replications}</td>
              <td>{metric(point.aggregate.successRate, percent)}</td>
              <td>{metric(point.aggregate.p95LatencyMs, millis)}</td>
              <td>{metric(point.aggregate.p99LatencyMs, millis)}</td>
              {services.map((service) => {
                const metrics = point.aggregate.services[service];
                const totals = metrics?.totals;
                return (
                  <Fragment key={service}>
                    <td>{metric(metrics?.admittedAmplification, times)}</td>
                    <td>{totals == null || totals.handlerCapacityTimeMs === 0
                      ? "n/a" : percent(totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs)}</td>
                  </Fragment>
                );
              })}
              <td><SaturationInsight saturation={point.saturation} replications={variant.replications} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
