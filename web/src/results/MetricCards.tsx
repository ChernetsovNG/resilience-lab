import type { VariantResult } from "../api/types";

interface MetricCardsProps {
  variant: VariantResult;
}

function format(value: number | null | undefined, unit = ""): string {
  return value === null || value === undefined ? "N/A" : `${value.toFixed(2)}${unit}`;
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function MetricCards({ variant }: MetricCardsProps) {
  const { aggregate } = variant;
  const pooledAll = aggregate.pooledLatency.all;

  return (
    <dl className="metric-cards">
      <MetricCard
        label="Success rate"
        value={
          aggregate.successRate === null
            ? "N/A"
            : format(aggregate.successRate.mean * 100, "%")
        }
      />
      <MetricCard label="Pooled all-latency p95" value={format(pooledAll?.p95Ms, " ms")} />
      <MetricCard label="Pooled all-latency p99" value={format(pooledAll?.p99Ms, " ms")} />
      {Object.entries(aggregate.services).flatMap(([serviceId, services]) => [
        <MetricCard
          key={`${serviceId}-admitted`}
          label={`${serviceId} admitted amplification`}
          value={format(services.admittedAmplification?.mean, "×")}
        />,
        <MetricCard
          key={`${serviceId}-offered`}
          label={`${serviceId} offered amplification`}
          value={format(services.offeredAmplification?.mean, "×")}
        />,
      ])}
    </dl>
  );
}
