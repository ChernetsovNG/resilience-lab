import type { RunSummary } from "../api/apiTypes";

type Aggregate = RunSummary["variants"][number]["points"][number]["aggregate"];

/** Existing instance views exclude group aggregates until the T4 group presentations. */
export function instanceServiceEntries(aggregate: Aggregate) {
  const groups = new Set(aggregate.groups.filter(group => group.kind === "NODE").map(group => group.id));
  return Object.entries(aggregate.services).filter(([id]) => !groups.has(id));
}
