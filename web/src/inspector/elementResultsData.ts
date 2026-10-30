import type { Catalog, ExperimentFile, ModelFile, OutputDescriptor, RunManifest, RunSummary } from "../api/apiTypes";
import type { DecodedConnection, NodeSeriesMetrics } from "../results/series/types";
import { outputValue, outputWindow, outputsOf, type OutputValue } from "../results/outputs";
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

export type ElementMetric = OutputValue;
export interface ElementResultsData {
  kind: string;
  id: string;
  timeoutMs: number | null;
  outputs: OutputDescriptor[];
  windows: ReturnType<typeof outputWindow>[];
  values: Record<string, ElementMetric>;
  latencyCoverage?: { fromMs: number; toMs: number };
}

/** Run identity follows editor lineage; removing and re-adding an ID cannot inherit its old results. */
export function resultSelection(runModel: ModelFile, currentModel: ModelFile, selected: string | null) {
  if (selected === null) return null;
  const sameBlock = (id: string) => {
    const original = ownEntry(runModel.blocks, id), current = ownEntry(currentModel.blocks, id);
    return original !== undefined && current !== undefined && original.type === current.type
      && elementIdentity(original) === elementIdentity(current);
  };
  const block = ownEntry(runModel.blocks, selected);
  if (block !== undefined && sameBlock(selected)) return { id: selected, kind: block.type, category: "BLOCK" as const, target: null };
  const original = runModel.connections.find(connection => connection.id === selected);
  const current = currentModel.connections.find(connection => connection.id === selected);
  return original !== undefined && current?.type === original.type && original.from === current.from && original.to === current.to
    && elementIdentity(original) === elementIdentity(current) && sameBlock(original.from) && sameBlock(original.to)
    ? { id: selected, kind: original.type, category: "CONNECTION" as const, target: original.to } : null;
}

/** Summary rates and time averages stay pooled; event counts are per replication. Only supplied replication metrics carry their unmodified Student bounds. */
export function projectElementResults(context: ElementResultsContext): ElementResultsData | null {
  const { summary, manifest, runModel, currentModel, experiment, catalog, variantId, pointId, replication, window, selected } = context;
  const selection = resultSelection(runModel, currentModel, selected);
  const variant = summary.variants.find(candidate => candidate.id === variantId);
  const point = variant?.points.find(candidate => candidate.id === pointId);
  if (selection === null || point === undefined || variant === undefined || replication < 0 || replication >= variant.replications) return null;
  const outputs = outputsOf(catalog, selection.kind).filter(output => output.inspector != null);
  if (outputs.length === 0) return null;
  const block = selection.category === "BLOCK";
  const aggregate = block ? ownEntry(point.aggregate.services, selection.id) : ownEntry(point.aggregate.connections, selection.id);
  if (aggregate === undefined) return null;
  const descriptor = catalog.types.find(type => type.id === selection.kind)!;
  const effective = applyOverrides(applyOverrides(runModel,
    experiment.variants.find(variant => variant.id === variantId)?.overrides ?? {}, catalog), point.coordinates, catalog);
  const element = block ? ownEntry(effective.blocks, selection.id) : effective.connections.find(connection => connection.id === selection.id);
  const params: Record<string, unknown> = { ...Object.fromEntries(descriptor.params.map(param => [param.name, param.default])), ...element?.params };
  const node = context.nodes?.find(node => node.id === selection.id);
  const frames = block ? node?.windows ?? [] : context.connections?.find(connection => connection.id === selection.id)?.windows ?? [];
  const target = context.nodes?.find(node => node.id === selection.target);
  const frameContext = (index: number) => frames[index] === undefined ? undefined : {
    ...frames[index], params, target: target?.windows[index],
    client: (block ? node?.windows[index] : target?.windows[index])?.client,
  };
  const metadata = manifest.series;
  const endMs = (metadata?.warmupMs ?? 0) + (metadata?.measurementMs ?? 0);
  let count = 0, sumMs = 0;
  if (metadata != null && node?.latency !== undefined) {
    node.windows.forEach((frame, index) => {
      const latency = node.latency?.[index];
      if (latency !== undefined && frame.startMs >= metadata.warmupMs && frame.startMs + frame.durationMs <= endMs) {
        count += latency.count; sumMs += latency.sumMs;
      }
    });
  }
  const summaryContext = { ...aggregate, params, replications: variant.replications,
    target: selection.target === null ? undefined : ownEntry(point.aggregate.services, selection.target),
    measurementLatency: { count, sumMs } };
  const valueContext = window === null ? summaryContext : Number.isInteger(window) && window >= 0 ? frameContext(window) : undefined;
  const threshold = outputs.find(output => output.inspector?.thresholdParameter != null)?.inspector?.thresholdParameter;
  const timeout = threshold == null ? undefined : params[threshold];
  const timeoutUnits = descriptor.params.find(param => param.name === threshold)?.units ?? [];
  const coverage = outputs.some(output => output.summary?.source === "REPLICATION") && metadata != null && metadata.warmupMs % metadata.windowMs !== 0
    ? { fromMs: Math.min(endMs, Math.ceil(metadata.warmupMs / metadata.windowMs) * metadata.windowMs), toMs: endMs } : undefined;
  return { kind: selection.kind, id: selection.id, outputs, latencyCoverage: coverage,
    timeoutMs: typeof timeout === "string" ? canonicalOf(timeout, timeoutUnits) : null,
    windows: frames.map((_, index) => outputWindow(outputs, frameContext(index)!)),
    values: Object.fromEntries(outputs.filter(output => output.inspector?.showValue)
      .map(output => [output.id, outputValue(output, valueContext, window !== null)])),
  };
}
