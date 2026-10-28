import type { SaturationSummary } from "../api/apiTypes";

const millis = (value: number) => `${value.toFixed(1)} ms`;

/** Formats recorded saturation insight without recalculating the rule, onset statistics or core ordering. */
export function formatSaturation(saturation: SaturationSummary, replications: number) {
  return {
    firstNodes: saturation.firstNodes.length === 0 ? ["No saturation."] : saturation.firstNodes.map((first) =>
      `${first.node} first in ${first.replicationCount} of ${replications} replications; ` +
      `median start ${millis(first.medianStartMs)}, range ${first.minStartMs.toFixed(1)}–${millis(first.maxStartMs)}.`),
    withoutSaturation: `${saturation.withoutSaturation} of ${replications} replications without saturation.`,
    degradationPaths: saturation.replications.map(({ replication, degradationPath }) =>
      `Replication ${replication}: ` + (degradationPath.length === 0 ? "no saturation."
        : degradationPath.map(({ node, startMs }) => `${node} at ${millis(startMs)}`).join(" → "))),
    rule: `Saturation rule: ${Object.entries(saturation.rule).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join("; ")}.`,
  };
}
