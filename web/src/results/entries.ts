import type { Catalog, ModelFile, RunSummary } from "../api/apiTypes";
import { applyOverrides, ownEntry, type Params } from "../workspace/params";
import { confidenceInterval } from "./confidence";

type Aggregate = RunSummary["variants"][number]["points"][number]["aggregate"];
export type EntryMetrics = Aggregate["entries"]["total"];
export type EntrySelection = "total" | `clients:${string}` | `classes:${string}`;

/** Only effective run models contribute populations; an overridden base class must not reappear. */
export function entryModels(summary: RunSummary, model: ModelFile | null | undefined, catalog: Catalog | null | undefined,
  variants: readonly { id: string; overrides?: Params }[]): ModelFile[] {
  if (model == null) return [];
  if (catalog == null) return [model];
  return summary.variants.flatMap(variant => variant.points.map(point => applyOverrides(applyOverrides(model,
    variants.find(source => source.id === variant.id)?.overrides ?? {}, catalog), point.coordinates, catalog)));
}

/** The same observation-count rule as the total entry, including refusal and fallback intervals. */
export function hasUnreliableEntryInterval(entry: EntryMetrics | undefined): boolean {
  return [entry?.successRate, entry?.p95LatencyMs, entry?.p99LatencyMs, entry?.degradedRate,
    ...Object.values(entry?.failuresByReason ?? {})].some(metric => metric != null && metric.count < 5 && confidenceInterval(metric, 95) !== null);
}

/** IDs include missing populations from the run model, so absent metrics remain visibly unavailable. */
export function entryPopulations(aggregates: readonly Aggregate[], models: readonly (ModelFile | null | undefined)[] = []) {
  const clients = new Set(aggregates.flatMap(aggregate => Object.keys(aggregate.entries.clients)));
  const classes = new Set(aggregates.flatMap(aggregate => Object.keys(aggregate.entries.classes)));
  for (const model of models) for (const [id, block] of Object.entries(model?.blocks ?? {})) {
    if (block.type !== "client") continue;
    clients.add(id);
    for (const type of requestTypes(block.params)) classes.add(type);
  }
  return { clients: [...clients].sort(), classes: [...classes].sort() };
}

/** Request-type IDs are global to the model; the default population comes from clients using load. */
export function requestTypes(params: Record<string, unknown>): string[] {
  return Array.isArray(params.classes) ? params.classes.flatMap(type =>
    typeof type?.id === "string" ? [type.id] : []) : ["default"];
}

export function selectedEntry(entries: Aggregate["entries"], selection: EntrySelection): EntryMetrics | undefined {
  if (selection === "total") return entries.total;
  const kind = selection.startsWith("clients:") ? "clients" : "classes";
  return ownEntry(entries[kind], selection.slice(kind.length + 1));
}

export function hasFallback(aggregates: readonly Aggregate[], models: readonly (ModelFile | null | undefined)[]): boolean {
  return models.some(model => model?.connections.some(connection => connection.params.fallback != null))
    || aggregates.some(aggregate => [aggregate.entries.total, ...Object.values(aggregate.entries.clients),
      ...Object.values(aggregate.entries.classes)].some(entry => (entry.degradedRate?.mean ?? 0) !== 0));
}

/** Existing single-client examples keep their original rows; new entry/policy models expose refusal details. */
export function hasEntryDetails(aggregates: readonly Aggregate[], models: readonly (ModelFile | null | undefined)[]): boolean {
  const populations = entryPopulations(aggregates, models);
  const policies = ["circuitBreaker", "retryBudget", "fallback", "outlierDetection", "rateLimit", "healthCheck"];
  return populations.clients.length > 1 || populations.classes.length > 1 || hasFallback(aggregates, models)
    || models.some(model => Object.values(model?.blocks ?? {}).some(block =>
      (block.type === "client" && Array.isArray(block.params.classes)) || policies.some(key => block.params[key] != null))
      || model?.connections.some(connection => policies.some(key => connection.params[key] != null)));
}

/** Same ordering as CLI: descending saved mean, then code. No rates are recomputed in the browser. */
export function sortedFailureReasons(entry: EntryMetrics | undefined): string[] {
  return Object.keys(entry?.failuresByReason ?? {}).filter(code => entry!.failuresByReason[code].mean > 0)
    .sort((a, b) => entry!.failuresByReason[b].mean - entry!.failuresByReason[a].mean || (a < b ? -1 : a > b ? 1 : 0));
}

/** Missing codes in an existing population mean zero refusals; a missing population stays unavailable. */
export function failureMetric(entry: EntryMetrics | undefined, code: string) {
  return entry === undefined ? undefined : ownEntry(entry.failuresByReason, code)
    ?? { mean: 0, stdDev: 0, count: entry.successRate?.count ?? 0, min: 0, max: 0 };
}
