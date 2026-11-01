import type { Catalog, ExperimentFile, ModelFile, OutputDescriptor, RunManifest, RunSummary } from "../api/apiTypes";
import type { DecodedConnection, NodeSeriesMetrics } from "../results/series/types";
import { outputValue, outputWindow, outputsOf, requestAttemptContext, type AmplificationUnavailableReason, type OutputValue } from "../results/outputs";
import { elementIdentity } from "../workspace/editor";
import { applyOverrides, ownEntry } from "../workspace/params";
import { groupInspectorOutputs, replicaMember, type ReplicaGroup } from "../results/groups";
import { canonicalOf } from "../workspace/quantities";
import { policyOutputAvailable } from "../workspace/policyParameters";
import { entryModels } from "../results/entries";

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
  amplificationUnavailableReason: AmplificationUnavailableReason;
}

/** Run identity follows editor lineage; removing and re-adding an ID cannot inherit its old results. */
export function resultSelection(runModel: ModelFile, currentModel: ModelFile, selected: string | null, groups: readonly ReplicaGroup[] = []) {
  if (selected === null) return null;
  const sameBlock = (id: string) => {
    const original = ownEntry(runModel.blocks, id), current = ownEntry(currentModel.blocks, id);
    return original !== undefined && current !== undefined && original.type === current.type
      && elementIdentity(original) === elementIdentity(current);
  };
  const member = replicaMember(groups, selected);
  const elementId = member?.group.id ?? selected;
  const block = ownEntry(runModel.blocks, elementId);
  if (block !== undefined && sameBlock(elementId)) return { id: selected, elementId, replica: member?.instance.replica, kind: block.type, category: "BLOCK" as const, source: null, target: null };
  const original = runModel.connections.find(connection => connection.id === elementId);
  const current = currentModel.connections.find(connection => connection.id === elementId);
  return original !== undefined && current?.type === original.type && original.from === current.from && original.to === current.to
    && elementIdentity(original) === elementIdentity(current) && sameBlock(original.from) && sameBlock(original.to)
    ? { id: selected, elementId, replica: member?.instance.replica, kind: original.type, category: "CONNECTION" as const, source: original.from, target: original.to } : null;
}

/** Availability includes direct client aggregates as well as catalog-defined element outputs. */
export function hasElementResults(context: ElementResultsContext): boolean {
  const variant = context.summary.variants.find(variant => variant.id === context.variantId);
  const point = variant?.points.find(point => point.id === context.pointId);
  if (variant === undefined || point === undefined || context.replication < 0 || context.replication >= variant.replications) return false;
  const selection = resultSelection(context.runModel, context.currentModel, context.selected, point.aggregate.groups);
  return selection?.kind === "client" ? ownEntry(point.aggregate.entries.clients, selection.id) !== undefined
    : projectElementResults(context) !== null;
}

/** Summary rates and time averages stay pooled; event counts are per replication. Only supplied replication metrics carry their unmodified Student bounds. */
export function projectElementResults(context: ElementResultsContext): ElementResultsData | null {
  const { summary, manifest, runModel, currentModel, experiment, catalog, variantId, pointId, replication, window, selected } = context;
  const variant = summary.variants.find(candidate => candidate.id === variantId);
  const point = variant?.points.find(candidate => candidate.id === pointId);
  const selection = resultSelection(runModel, currentModel, selected, point?.aggregate.groups);
  if (selection === null || point === undefined || variant === undefined || replication < 0 || replication >= variant.replications) return null;
  const grouped = selection.replica !== undefined || point.aggregate.groups.some(group => group.kind === "NODE" && group.id === selection.id);
  const models = entryModels(summary, runModel, catalog, experiment.variants);
  const outputs = (grouped ? groupInspectorOutputs(outputsOf(catalog, selection.kind)) : outputsOf(catalog, selection.kind).filter(output => output.inspector != null))
    .filter(output => policyOutputAvailable(output.id, selection.elementId, models, selection.replica));
  if (outputs.length === 0) return null;
  const block = selection.category === "BLOCK";
  const aggregate = block
    ? selection.kind === "client" ? ownEntry(point.aggregate.entries.clients, selection.id)
      : selection.kind === "pooler" ? ownEntry(point.aggregate.poolers, selection.id) : ownEntry(point.aggregate.services, selection.id)
    : selection.kind === "request" ? ownEntry(point.aggregate.entries.clients, selection.source!)
      : ownEntry(point.aggregate.connections, selection.id);
  if (aggregate === undefined) return null;
  const descriptor = catalog.types.find(type => type.id === selection.kind)!;
  const effective = applyOverrides(applyOverrides(runModel,
    experiment.variants.find(variant => variant.id === variantId)?.overrides ?? {}, catalog), point.coordinates, catalog);
  const element = block ? ownEntry(effective.blocks, selection.elementId) : effective.connections.find(connection => connection.id === selection.elementId);
  const params: Record<string, unknown> = { ...Object.fromEntries(descriptor.params.map(param => [param.name, param.default])), ...element?.params,
    ...(block && selection.replica !== undefined ? ownEntry(effective.blocks, selection.elementId)?.replicaOverrides?.[String(selection.replica)] : {}) };
  const node = context.nodes?.find(node => node.id === selection.id);
  const source = context.nodes?.find(node => node.id === selection.source);
  const frames = block ? node?.windows ?? [] : selection.kind === "request" ? source?.windows ?? []
    : context.connections?.find(connection => connection.id === selection.id)?.windows ?? [];
  const target = context.nodes?.find(node => node.id === selection.target);
  const frameContext = (index: number) => frames[index] === undefined ? undefined : {
    ...frames[index], ...(selection.kind === "request" ? requestAttemptContext(frames[index], true) : {}), params, target: target?.windows[index],
    entries: (block ? node?.windows[index] : target?.windows[index])?.entries,
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
  const targetSummary = selection.target === null ? undefined
    : ownEntry(point.aggregate.services, selection.target) ?? ownEntry(point.aggregate.poolers, selection.target);
  const summaryContext = { ...(selection.kind === "request" ? requestAttemptContext(aggregate) : aggregate), params, replications: variant.replications, target: targetSummary,
    measurementLatency: { count, sumMs } };
  const valueContext = window === null ? summaryContext : Number.isInteger(window) && window >= 0 ? frameContext(window) : undefined;
  const threshold = outputs.find(output => output.inspector?.thresholdParameter != null)?.inspector?.thresholdParameter;
  const timeout = threshold == null ? undefined : params[threshold];
  const timeoutUnits = descriptor.params.find(param => param.name === threshold)?.units ?? [];
  const coverage = outputs.some(output => output.summary?.source === "REPLICATION") && metadata != null && metadata.warmupMs % metadata.windowMs !== 0
    ? { fromMs: Math.min(endMs, Math.ceil(metadata.warmupMs / metadata.windowMs) * metadata.windowMs), toMs: endMs } : undefined;
  const amplificationUnavailableReason = targetSummary === undefined ? "unsupportedTarget" : window === null
    ? targetSummary.admittedAmplification === null ? "noArrivals" : "missingData"
    : valueContext !== undefined && target?.windows[window]?.entries.total.originalArrivals === 0 ? "noArrivals" : "missingData";
  return { kind: selection.kind, id: selection.id, outputs, latencyCoverage: coverage, amplificationUnavailableReason,
    timeoutMs: typeof timeout === "string" ? canonicalOf(timeout, timeoutUnits) : null,
    windows: frames.map((_, index) => outputWindow(outputs, frameContext(index)!)),
    values: Object.fromEntries(outputs.filter(output => output.inspector?.showValue)
      .map(output => [output.id, outputValue(output, valueContext, window !== null)])),
  };
}
