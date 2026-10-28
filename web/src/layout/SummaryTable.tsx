import type { MetricSummary, RunSummary } from "../api/apiTypes";

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

/** Metrics by variant (stage 1 design §6.3, Summary tab). */
export function SummaryTable({ summary }: { summary: RunSummary }) {
  const services = [...new Set(summary.variants.flatMap((variant) => Object.keys(variant.aggregate.services)))].sort();
  return (
    <table className="summary-table" aria-label="Summary">
      <thead>
        <tr>
          <th scope="col">Variant</th>
          <th scope="col">Replications</th>
          <th scope="col">Success rate</th>
          <th scope="col">p95 latency</th>
          <th scope="col">p99 latency</th>
          {services.map((service) => (
            <th key={service} scope="col">
              {service} admitted ×
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {summary.variants.map((variant) => (
          <tr key={variant.id}>
            <th scope="row">{variant.label}</th>
            <td>{variant.replications}</td>
            <td>{metric(variant.aggregate.successRate, percent)}</td>
            <td>{metric(variant.aggregate.p95LatencyMs, millis)}</td>
            <td>{metric(variant.aggregate.p99LatencyMs, millis)}</td>
            {services.map((service) => (
              <td key={service}>{metric(variant.aggregate.services[service]?.admittedAmplification, times)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
