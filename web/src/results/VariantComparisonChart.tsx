import {
  Bar,
  BarChart,
  ErrorBar,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricSummary, VariantResult } from "../api/types";

interface VariantComparisonChartProps {
  variants: VariantResult[];
}

interface ChartPoint {
  name: string;
  value: number | null;
  error: [number, number];
}

function point(name: string, summary: MetricSummary | null, scale = 1): ChartPoint {
  if (summary === null) return { name, value: null, error: [0, 0] };
  const value = summary.mean * scale;
  const error: [number, number] =
    summary.ci95Low === null || summary.ci95High === null
      ? [0, 0]
      : [value - summary.ci95Low * scale, summary.ci95High * scale - value];
  return { name, value, error };
}

function format(value: number | null | undefined, unit = ""): string {
  return value === null || value === undefined ? "N/A" : `${value.toFixed(2)}${unit}`;
}

function interval(summary: MetricSummary | null, scale = 1, unit = ""): string {
  if (
    summary?.ci95Low === null ||
    summary?.ci95Low === undefined ||
    summary.ci95High === null ||
    summary.ci95High === undefined
  ) {
    return "not enough replications";
  }
  return `95% CI [${format(summary.ci95Low * scale, unit)}, ${format(summary.ci95High * scale, unit)}]`;
}

function Chart({ data, name }: { data: ChartPoint[]; name: string }) {
  return (
    <div style={{ width: 720, maxWidth: "100%", height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 16, right: 24, bottom: 16, left: 24 }}>
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="value" name={name} fill="#2563eb">
            <ErrorBar dataKey="error" stroke="#1e293b" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function VariantComparisonChart({ variants }: VariantComparisonChartProps) {
  const success = variants.map((variant) =>
    point(variant.label, variant.aggregate.successRate, 100),
  );
  const amplification = variants.flatMap((variant) =>
    Object.entries(variant.aggregate.services).map(([serviceId, service]) =>
      point(`${variant.label} · ${serviceId}`, service.admittedAmplification),
    ),
  );

  return (
    <figure aria-label="Variant comparison">
      <Chart data={success} name="Success rate (%)" />
      <Chart data={amplification} name="Admitted amplification" />
      <figcaption>
        <strong>Variant comparison.</strong> Success rate and admitted amplification bars include
        95% confidence intervals when enough replications are available.
        <ul>
          {variants.map((variant) => {
            const { aggregate } = variant;
            const latency = aggregate.pooledLatency.all;
            const summaries = [
              aggregate.successRate,
              ...Object.values(aggregate.services).map((service) => service.admittedAmplification),
            ];
            const missingInterval = summaries.some(
              (summary) =>
                summary === null || summary.ci95Low === null || summary.ci95High === null,
            );
            return (
              <li key={variant.id}>
                {variant.label}: {missingInterval ? "not enough replications. " : ""}
                Success {format(aggregate.successRate?.mean === undefined ? null : aggregate.successRate.mean * 100, "%")} ({interval(aggregate.successRate, 100, "%")});
                p95 {format(latency?.p95Ms, " ms")}; p99 {format(latency?.p99Ms, " ms")}.
                {Object.entries(aggregate.services).map(([serviceId, service]) => (
                  <span key={serviceId}>
                    {" "}{serviceId} admitted amplification {format(service.admittedAmplification?.mean, "×")} ({interval(service.admittedAmplification, 1, "×")}).
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
