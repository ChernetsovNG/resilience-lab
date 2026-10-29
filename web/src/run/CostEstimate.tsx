import type { ExperimentEstimate } from "../api/apiTypes";

const size = (bytes: number): [number, string] => bytes < 1024 ** 2
  ? [bytes / 1024, "KiB"] : [bytes / 1024 ** 2, "MiB"];

/** API estimates, including uncertainty warnings; no local cost calculation. */
export function CostEstimate({ estimate }: { estimate: ExperimentEstimate }) {
  const values: [string, number, string?][] = [
    ["Tasks", estimate.tasks], ["Workers", estimate.workers],
    ["Expected events", estimate.expectedEvents], ["Expected rows", estimate.expectedRows],
    ["Estimated time", estimate.estimatedSeconds, "s"],
    ["Uncompressed size", ...size(estimate.estimatedUncompressedBytes)],
    ["Artifact size", ...size(estimate.estimatedArtifactBytes)], ["Parts", estimate.estimatedParts],
  ];
  return <section className="cost-estimate" aria-label="Cost estimate">
    <strong>Cost estimate</strong>
    <dl>{values.map(([label, value, unit]) => <div key={label}>
      <dt>{label}</dt>
      <dd><output aria-label={label}>{value.toLocaleString("en-US", { maximumFractionDigits: 3 })}{unit ? ` ${unit}` : ""}</output></dd>
    </div>)}</dl>
    {estimate.warnings.length === 0 ? null : <ul>{estimate.warnings.map((warning) =>
      <li key={warning.code}>{warning.message}</li>)}</ul>}
  </section>;
}
