import type { OutputDescriptor, RunSummary } from "../api/apiTypes";

export type ResultAggregate = RunSummary["variants"][number]["points"][number]["aggregate"];
export type ReplicaGroup = ResultAggregate["groups"][number];

/** Artifact membership is authoritative; generated addresses are never parsed as document identifiers. */
export function replicaMember(groups: readonly ReplicaGroup[], id: string) {
  for (const group of groups) {
    const instance = group.instances.find(instance => instance.id === id);
    if (instance !== undefined) return { group, instance };
  }
  return null;
}

/** Union across comparison columns/points, keeping replicas under their group even when counts differ. */
export function serviceResultRows(aggregates: readonly ResultAggregate[]) {
  const groups = new Map<string, Map<string, ReplicaGroup["instances"][number]>>();
  const members = new Set<string>();
  for (const aggregate of aggregates) for (const group of aggregate.groups) {
    if (group.kind !== "NODE") continue;
    const instances = groups.get(group.id) ?? new Map();
    for (const instance of group.instances) { members.add(instance.id); instances.set(instance.id, instance); }
    groups.set(group.id, instances);
  }
  const ids = new Set(aggregates.flatMap(aggregate => Object.keys(aggregate.services)));
  return [...ids].filter(id => !members.has(id)).sort().map(id => ({ id,
    instances: [...(groups.get(id)?.values() ?? [])].sort((a, b) => a.replica - b.replica),
  }));
}

/** Group/replica inspectors use the catalog's recorded cohort summaries, including merged p99. */
export function groupInspectorOutputs(outputs: readonly OutputDescriptor[]): OutputDescriptor[] {
  const replacements: Record<string, string> = { utilization: "groupUtilization", meanQueue: "groupMeanQueue", meanLatencyMs: "groupMeanLatencyMs" };
  const result = outputs.filter(output => output.inspector != null).map(output => {
    const replacement = outputs.find(candidate => candidate.id === replacements[output.id]);
    return replacement === undefined ? output : { ...replacement, id: output.id, inspector: output.inspector };
  });
  const p99 = outputs.find(output => output.id === "groupP99LatencyMs");
  if (p99 !== undefined) result.push({ ...p99, inspector: {
    title: outputs.find(output => output.id === "p99LatencyMs")?.title ?? p99.title,
    order: 6, showValue: true, chartOrder: null, thresholdParameter: null,
  } });
  return result;
}
