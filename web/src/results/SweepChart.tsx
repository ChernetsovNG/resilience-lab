import { useId, useState } from "react";
import {
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricSummary, SweepParameter, VariantResult } from "../api/types";

type SweepMetric = "successRate" | "p95" | "amplification";

interface SweepChartProps {
  variants: VariantResult[];
}

interface SweepPoint {
  sweepValue: number;
  value: number | null;
  services: Record<string, number | null>;
}

function format(value: number | null | undefined, unit: string): string {
  return value === null || value === undefined ? "N/A" : `${value.toFixed(2)}${unit}`;
}

function formatSummary(
  summary: MetricSummary | null | undefined,
  scale: number,
  unit: string,
): string {
  const value = summary === null || summary === undefined ? null : summary.mean * scale;
  const interval =
    summary?.ci95Low === null ||
    summary?.ci95Low === undefined ||
    summary.ci95High === null ||
    summary.ci95High === undefined
      ? "not enough replications"
      : `95% CI [${format(summary.ci95Low * scale, unit)}, ${format(summary.ci95High * scale, unit)}]`;
  return `${format(value, unit)} (${interval})`;
}

export function SweepChart({ variants }: SweepChartProps) {
  const id = useId();
  const [metric, setMetric] = useState<SweepMetric>("successRate");
  const [parameter, setParameter] = useState<SweepParameter | null>(null);
  const eligible = variants.filter(
    (variant) => variant.sweepParameter !== null && variant.sweepValue !== null,
  );
  const parameters = [
    ...new Set(eligible.map((variant) => variant.sweepParameter as SweepParameter)),
  ];
  const selectedParameter =
    parameter !== null && parameters.includes(parameter) ? parameter : (parameters[0] ?? null);
  const points = eligible
    .filter((variant) => variant.sweepParameter === selectedParameter)
    .sort((left, right) => (left.sweepValue ?? 0) - (right.sweepValue ?? 0));
  const serviceIds = [...new Set(points.flatMap((variant) => Object.keys(variant.aggregate.services)))];
  const data: SweepPoint[] = points.map((variant) => ({
    sweepValue: variant.sweepValue as number,
    value:
      metric === "successRate"
        ? variant.aggregate.successRate === null
          ? null
          : variant.aggregate.successRate.mean * 100
        : metric === "p95"
          ? (variant.aggregate.p95LatencyMs?.mean ?? null)
          : null,
    services: Object.fromEntries(
      Object.entries(variant.aggregate.services).map(([serviceId, service]) => [
        serviceId,
        service.admittedAmplification?.mean ?? null,
      ]),
    ),
  }));
  const unit = metric === "successRate" ? "%" : metric === "p95" ? " ms" : "×";

  return (
    <figure aria-label="Parameter sweep">
      <label htmlFor={`${id}-parameter`}>Sweep chart parameter</label>
      <select
        id={`${id}-parameter`}
        name="sweepChartParameter"
        value={selectedParameter ?? ""}
        onChange={(event) => setParameter(event.target.value as SweepParameter)}
      >
        {parameters.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <label htmlFor={`${id}-metric`}>Sweep metric</label>
      <select
        id={`${id}-metric`}
        name="sweepMetric"
        value={metric}
        onChange={(event) => setMetric(event.target.value as SweepMetric)}
      >
        <option value="successRate">Success rate</option>
        <option value="p95">p95 latency</option>
        <option value="amplification">Admitted amplification</option>
      </select>
      <div style={{ width: 720, maxWidth: "100%", height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 16, right: 24, bottom: 16, left: 24 }}>
            <XAxis
              dataKey="sweepValue"
              type="number"
              ticks={data.map((point) => point.sweepValue)}
              domain={["dataMin", "dataMax"]}
              label={{ value: selectedParameter ?? "", position: "insideBottom", offset: -10 }}
            />
            <YAxis />
            <Tooltip />
            <Legend />
            {metric === "amplification" ? (
              serviceIds.map((serviceId, index) => (
                <Line
                  key={serviceId}
                  dataKey={`services.${serviceId}`}
                  name={serviceId}
                  stroke={index % 2 === 0 ? "#2563eb" : "#7c3aed"}
                />
              ))
            ) : (
              <Line
                dataKey="value"
                name={metric === "successRate" ? "Success rate (%)" : "p95 latency (ms)"}
                stroke="#2563eb"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption>
        <strong>Parameter sweep: {selectedParameter}.</strong> X values come from sweep metadata.
        <ul>
          {points.map((variant) => {
            const value = metric === "amplification"
              ? serviceIds.map((serviceId) =>
                  `${serviceId} ${formatSummary(variant.aggregate.services[serviceId]?.admittedAmplification, 1, unit)}`,
                ).join(", ")
              : formatSummary(
                  metric === "successRate"
                    ? variant.aggregate.successRate
                    : variant.aggregate.p95LatencyMs,
                  metric === "successRate" ? 100 : 1,
                  unit,
                );
            return <li key={variant.id}>{variant.sweepValue}: {value}</li>;
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
