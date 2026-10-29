import type { Catalog, ExperimentFile, MetricSummary, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { canvasQueueCapacities } from "../results/canvasResults";
import type { DecodedConnection, NodeSeriesMetrics } from "../results/series/types";
import { elementIdentity } from "../workspace/editor";
import { applyOverrides, ownEntry } from "../workspace/params";
import { canonicalOf } from "../workspace/quantities";

export interface ElementResultsContext {
  summary: RunSummary;
  manifest: RunManifest;
  runModel: ModelFile;
  currentModel: ModelFile;
  experiment: ExperimentFile;
  catalog: Catalog;
  variantId: string;
  pointId: string;
  replication: number;
  window: number | null;
  selected: string | null;
  nodes?: readonly NodeSeriesMetrics[];
  connections?: readonly DecodedConnection[];
}

export interface ElementMetric {
  value: number | null;
  source: "pooled" | "replications" | "replication" | "perReplication" | "window";
  ci95Low?: number | null;
  ci95High?: number | null;
  approximate?: boolean;
}
export interface ElementResultsData {
  kind: "service" | "call";
  id: string;
  timeoutMs: number | null;
  values: Record<string, ElementMetric>;
  latencyCoverage?: { fromMs: number; toMs: number };
}

const ratio = (numerator: number | null | undefined, denominator: number | null | undefined): number | null =>
  numerator == null || denominator == null || denominator <= 0 ? null : numerator / denominator;
const metric = (value: number | null | undefined, source: ElementMetric["source"]): ElementMetric => ({ value: value ?? null, source });
const withInterval = (value: MetricSummary | null | undefined): ElementMetric => value == null
  ? metric(null, "replications") : { value: value.mean, source: "replications", ci95Low: value.ci95Low, ci95High: value.ci95High };

/** Run identity follows editor lineage; removing and re-adding an ID cannot inherit its old results. */
export function resultSelection(runModel: ModelFile, currentModel: ModelFile, selected: string | null) {
  if (selected === null) return null;
  const sameBlock = (id: string) => {
    const original = ownEntry(runModel.blocks, id), current = ownEntry(currentModel.blocks, id);
    return original !== undefined && current !== undefined && original.type === current.type
      && elementIdentity(original) === elementIdentity(current);
  };
  if (ownEntry(runModel.blocks, selected)?.type === "service" && sameBlock(selected)) {
    return { id: selected, kind: "service" as const };
  }
  const original = runModel.connections.find(connection => connection.id === selected);
  const current = currentModel.connections.find(connection => connection.id === selected);
  return original?.type === "call" && current?.type === "call" && original.from === current.from && original.to === current.to
    && elementIdentity(original) === elementIdentity(current) && sameBlock(original.from) && sameBlock(original.to)
    ? { id: selected, kind: "call" as const, target: original.to } : null;
}

/** Summary rates and time averages stay pooled; event counts are per replication. Only supplied replication metrics carry their unmodified Student bounds. */
export function projectElementResults(context: ElementResultsContext): ElementResultsData | null {
  const { summary, manifest, runModel, currentModel, experiment, catalog, variantId, pointId, replication, window, selected } = context;
  const selection = resultSelection(runModel, currentModel, selected);
  const variant = summary.variants.find(candidate => candidate.id === variantId);
  const point = variant?.points.find(candidate => candidate.id === pointId);
  if (selection === null || point === undefined || variant === undefined || replication < 0 || replication >= variant.replications) return null;
  const nodes = context.nodes ?? [];
  const source = window === null ? "pooled" : "window";
  const atWindow = <T,>(windows: readonly T[] | undefined) => window !== null && Number.isInteger(window) && window >= 0 ? windows?.[window] : undefined;
  if (selection.kind === "service") {
    const aggregate = ownEntry(point.aggregate.services, selection.id);
    if (aggregate === undefined) return null;
    const totals = aggregate.totals;
    const series = nodes.find(node => node.id === selection.id);
    const frame = atWindow(series?.windows);
    const meanQueue = window === null ? ratio(totals.queueLengthIntegralMs, totals.measurementMs) : frame?.meanQueueLength;
    const capacity = canvasQueueCapacities(runModel, experiment, catalog, variantId, point.coordinates).get(selection.id);
    const metadata = manifest.series;
    const endMs = (metadata?.warmupMs ?? 0) + (metadata?.measurementMs ?? 0);
    let count = 0, sumMs = 0;
    if (metadata !== null && metadata !== undefined && series?.latency !== undefined) {
      series.windows.forEach((frame, index) => {
        const latency = series.latency?.[index];
        if (latency !== undefined && frame.startMs >= metadata.warmupMs && frame.startMs + frame.durationMs <= endMs) {
          count += latency.count;
          sumMs += latency.sumMs;
        }
      });
    }
    const coverage = metadata !== null && metadata !== undefined && metadata.warmupMs % metadata.windowMs !== 0
      ? { fromMs: Math.min(endMs, Math.ceil(metadata.warmupMs / metadata.windowMs) * metadata.windowMs), toMs: endMs } : undefined;
    return { kind: selection.kind, id: selection.id, timeoutMs: null, latencyCoverage: coverage, values: {
      utilization: metric(window === null ? ratio(totals.busyHandlerTimeMs, totals.handlerCapacityTimeMs) : frame?.handlerUtilization, source),
      meanQueue: metric(meanQueue, source),
      queueFill: metric(ratio(meanQueue, capacity), source),
      queueRejectionRate: metric(window === null ? ratio(totals.queueRejections, totals.offeredAttempts)
        : ratio(frame?.queueRejectionsPerSecond, frame?.offeredAttemptsPerSecond), source),
      admittedAttemptsPerSecond: metric(window === null ? ratio(totals.admittedAttempts * 1000, totals.measurementMs) : frame?.admittedAttemptsPerSecond, source),
      meanLatencyMs: metric(window === null ? ratio(sumMs, count) : frame?.meanLatencyMs, window === null ? "replication" : "window"),
    } };
  }
  const aggregate = ownEntry(point.aggregate.connections, selection.id);
  if (aggregate === undefined) return null;
  const totals = aggregate.totals;
  const frame = atWindow(context.connections?.find(connection => connection.id === selection.id)?.windows);
  const target = ownEntry(point.aggregate.services, selection.target);
  const targetFrame = atWindow(nodes.find(node => node.id === selection.target)?.windows);
  const effective = applyOverrides(applyOverrides(runModel, experiment.variants.find(variant => variant.id === variantId)?.overrides ?? {}, catalog), point.coordinates, catalog);
  const descriptor = catalog.types.find(type => type.id === "call")?.params.find(param => param.name === "timeout");
  const timeout = effective.connections.find(connection => connection.id === selection.id)?.params.timeout ?? descriptor?.default;
  return { kind: selection.kind, id: selection.id,
    timeoutMs: typeof timeout === "string" ? canonicalOf(timeout, descriptor?.units ?? []) : null,
    values: {
      sentAttemptsPerSecond: metric(window === null ? ratio(totals.sentAttempts * 1000, totals.measurementMs) : ratio(frame?.sentAttempts === undefined ? null : frame.sentAttempts * 1000, frame?.durationMs), source),
      retriesPerSecond: metric(window === null ? ratio(totals.retries * 1000, totals.measurementMs) : ratio(frame?.retries === undefined ? null : frame.retries * 1000, frame?.durationMs), source),
      timeoutRate: window === null && aggregate.timeoutRate != null ? withInterval(aggregate.timeoutRate)
        : metric(window === null ? ratio(totals.timeouts, totals.sentAttempts) : ratio(frame?.timeouts, frame?.sentAttempts), source),
      orphaned: metric(window === null ? ratio(totals.orphaned, variant.replications) : frame?.orphaned, window === null ? "perReplication" : "window"),
      meanOrphaned: metric(window === null ? ratio(totals.orphanedIntegralMs, totals.measurementMs) : ratio(frame?.orphanedIntegralMs, frame?.durationMs), source),
      meanInFlight: window === null && aggregate.meanInFlight != null ? withInterval(aggregate.meanInFlight)
        : metric(window === null ? ratio(totals.inFlightIntegralMs, totals.measurementMs) : ratio(frame?.inFlightIntegralMs, frame?.durationMs), source),
      meanBackoff: metric(window === null ? ratio(totals.backoffIntegralMs, totals.measurementMs) : ratio(frame?.backoffIntegralMs, frame?.durationMs), source),
      meanLatencyMs: metric(window === null ? aggregate.pooledLatency?.meanMs : frame?.latency.meanMs, source),
      amplification: window === null ? withInterval(target?.admittedAmplification)
        : { ...metric(frame === undefined ? null : targetFrame?.amplification, "window"), approximate: true },
    },
  };
}
