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
import type { VariantResult } from "../api/types";

type SweepMetric = "successRate" | "p95" | "amplification";

interface SweepChartProps {
  variants: VariantResult[];
}

interface SweepPoint {
  sweepValue: number;
  value: number | null;
  services: Record<string, number | null>;
}

function format(value: number | null, unit: string): string {
  return value === null ? "N/A" : `${value.toFixed(2)}${unit}`;
}

export function SweepChart({ variants }: SweepChartProps) {
  const id = useId();
  const [metric, setMetric] = useState<SweepMetric>("successRate");
  const points = variants
    .filter((variant) => variant.sweepParameter !== null && variant.sweepValue !== null)
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
        <strong>Parameter sweep.</strong> X values come from sweep metadata.
        <ul>
          {points.map((variant, index) => {
            const point = data[index];
            const value = metric === "amplification"
              ? serviceIds.map((serviceId) => format(point.services[serviceId] ?? null, unit)).join(", ")
              : format(point.value, unit);
            return <li key={variant.id}>{point.sweepValue}: {value}</li>;
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
