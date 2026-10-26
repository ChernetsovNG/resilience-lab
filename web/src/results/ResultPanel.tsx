import type { ExperimentResult, ExperimentSubmission, ValidationIssue } from "../api/types";
import { MetricCards } from "./MetricCards";
import { ResultDownload } from "./ResultDownload";
import { SweepChart } from "./SweepChart";
import { VariantComparisonChart } from "./VariantComparisonChart";

interface ResultPanelProps {
  jobId: string | null;
  result: ExperimentResult | null;
  submission?: ExperimentSubmission | null;
  error?: string | null;
  issues?: ValidationIssue[];
}

export function ResultPanel({ jobId, result, submission, error, issues = [] }: ResultPanelProps) {
  return (
    <section className="result-panel" aria-labelledby="result-title">
      <h2 id="result-title">Experiment result</h2>
      {jobId ? (
        <p>
          <strong>Job ID:</strong> <code>{jobId}</code>
        </p>
      ) : null}
      {error || issues.length > 0 ? (
        <div role="alert">
          {error}
          {issues.length > 0 ? (
            <ul>
              {issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <strong>{issue.path}:</strong> {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <>
          <ResultDownload result={result} submission={submission} />
          <section aria-label="Model assumptions">
            <h3>Model assumptions</h3>
            <ul>
              <li>Blocking handlers remain occupied during retry/backoff and until the final local outcome.</li>
              <li>No cancellation or queue removal is performed; cancellation propagation is absent.</li>
              <li>Orphaned work continues to run and occupy resources, including accepted downstream work.</li>
              <li>Late responses are discarded.</li>
              <li>Each replication is fully drained: all measured-cohort client outcomes are known and all accepted work, including orphaned work, has finished.</li>
            </ul>
            <p>Downloaded analysis includes the complete numerical result and submitted configuration; interpret retry amplification under these assumptions.</p>
          </section>
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
