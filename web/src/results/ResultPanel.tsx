import type { ExperimentResult } from "../api/types";
import { MetricCards } from "./MetricCards";
import { ResultDownload } from "./ResultDownload";
import { SweepChart } from "./SweepChart";
import { VariantComparisonChart } from "./VariantComparisonChart";

interface ResultPanelProps {
  jobId: string | null;
  result: ExperimentResult | null;
  error?: string | null;
}

export function ResultPanel({ jobId, result, error }: ResultPanelProps) {
  return (
    <section className="result-panel" aria-labelledby="result-title">
      <h2 id="result-title">Experiment result</h2>
      {jobId ? (
        <p>
          <strong>Job ID:</strong> <code>{jobId}</code>
        </p>
      ) : null}
      {error ? <div role="alert">{error}</div> : null}
      {result ? (
        <>
          <ResultDownload result={result} />
          {result.variants.some(
            (variant) => variant.sweepParameter === null || variant.sweepValue === null,
          ) ? (
            <VariantComparisonChart
              variants={result.variants.filter(
                (variant) => variant.sweepParameter === null || variant.sweepValue === null,
              )}
            />
          ) : null}
          {result.variants.some(
            (variant) => variant.sweepParameter !== null && variant.sweepValue !== null,
          ) ? (
            <SweepChart variants={result.variants} />
          ) : null}
          {result.variants.map((variant) => (
            <section key={variant.id} aria-label={`${variant.label} metrics`}>
              <h3>{variant.label}</h3>
              <MetricCards variant={variant} />
            </section>
          ))}
        </>
      ) : (
        <p>No result available.</p>
      )}
    </section>
  );
}
