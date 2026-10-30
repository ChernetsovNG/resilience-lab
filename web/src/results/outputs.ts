import type { Catalog, ModelFile, OutputCalculation, OutputDescriptor, TypeDescriptor } from "../api/apiTypes";
import { formatDuration, formatMultiplier, formatNumber, formatPercent, formatRate } from "../i18n/format";

export interface OutputValue {
  value: number | null;
  source: "pooled" | "replications" | "replication" | "perReplication" | "window";
  stdDev?: number | null;
  ci95Low?: number | null;
  ci95High?: number | null;
  approximate?: boolean;
}

/** Resolve only own data properties. Catalog bindings are data, never JavaScript expressions. */
export function outputField(context: unknown, path: string | null | undefined): unknown {
  if (path == null) return undefined;
  let value = context;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const divide = (numerator: number | null, denominator: number | null): number | null =>
  numerator === null || denominator === null || denominator <= 0 ? null : number(numerator / denominator);

/** Closed calculations over raw counts, integrals and decoded latency statistics (ADR 0011). */
export function calculateOutput(calculation: OutputCalculation, context: unknown): number | null {
  const raw = outputField(context, calculation.field);
  const value = number(raw);
  const divisor = number(outputField(context, calculation.divisor));
  switch (calculation.kind) {
    case "VALUE": return value;
    case "RATE": return divide(value === null ? null : value * 1000, divisor);
    case "RATIO": return divide(value, divisor);
    case "NORMALIZED_RATIO": {
      const capacity = number(outputField(context, calculation.capacity));
      return divide(value, divisor === null || capacity === null || capacity <= 0 ? null : divisor * capacity);
    }
    case "MEAN": return divide(number(outputField(raw, "sumMs")), number(outputField(raw, "count")));
    case "QUANTILE": {
      const field = calculation.percentile === 0.5 ? "p50Ms" : calculation.percentile === 0.95 ? "p95Ms"
        : calculation.percentile === 0.99 ? "p99Ms" : null;
      return number(outputField(raw, field));
    }
    default: return null;
  }
}

/** Summary intervals belong to independent replications; pooled values do not acquire synthetic intervals. */
export function outputValue(output: OutputDescriptor, context: unknown, windowed: boolean): OutputValue {
  if (windowed) return { value: context == null ? null : calculateOutput(output.calculation, context), source: "window",
    ...(output.approximateWindow ? { approximate: true } : {}) };
  const binding = output.summary;
  const interval = outputField(context, binding?.intervalField);
  if (interval != null) return { value: number(outputField(interval, "mean")), source: "replications",
    stdDev: number(outputField(interval, "stdDev")),
    ci95Low: number(outputField(interval, "ci95Low")), ci95High: number(outputField(interval, "ci95High")) };
  return { value: binding == null ? null : calculateOutput(binding.calculation, context),
    source: binding?.source === "REPLICATION" ? "replication" : binding?.source === "PER_REPLICATION" ? "perReplication" : "pooled" };
}

export function formatOutput(output: Pick<OutputDescriptor, "unit">, value: number | null | undefined): string {
  switch (output.unit) {
    case "PER_SECOND": return formatRate(value);
    case "MILLISECONDS": return formatDuration(value);
    case "PERCENT": return formatPercent(value);
    case "MULTIPLIER": return formatMultiplier(value);
    default: return formatNumber(value);
  }
}

/** Output prose accepts the same named value/interval placeholders as the message catalogs. */
export function outputText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export const outputsOf = (catalog: Catalog, type: string): OutputDescriptor[] =>
  catalog.types.find(candidate => candidate.id === type)?.outputs ?? [];

/** A connection output can require the called block and the original-arrival denominator of its windows. */
export function outputsUseTarget(outputs: readonly OutputDescriptor[]): boolean {
  return outputs.some(output => [output.calculation.field, output.calculation.divisor, output.calculation.capacity]
    .some(path => path?.startsWith("target.") || path?.startsWith("client.")));
}

export function inspectorOutputs(outputs: readonly OutputDescriptor[], charts = false): OutputDescriptor[] {
  return outputs.filter(output => charts ? output.inspector?.chartOrder != null : output.inspector?.showValue)
    .sort((a, b) => charts ? a.inspector!.chartOrder! - b.inspector!.chartOrder! : a.inspector!.order - b.inspector!.order);
}

export type OverlayOutput = OutputDescriptor & { key: string; types: string[] };

/** Share a selector only when the type-local definitions agree; IDs alone are not globally unique. */
export function overlayOutputs(catalog: Catalog, category: TypeDescriptor["category"], model?: ModelFile): OverlayOutput[] {
  const present = model === undefined ? null : new Set([
    ...Object.values(model.blocks).map(block => block.type), ...model.connections.map(connection => connection.type),
  ]);
  const choices: { output: OutputDescriptor; signature: string; types: string[] }[] = [];
  for (const type of catalog.types.filter(type => type.category === category)) for (const output of type.outputs ?? []) {
    if (output.overlay == null) continue;
    const signature = JSON.stringify([output.id, output.unit, output.kind, output.calculation,
      output.summary ?? null, output.overlay, output.approximateWindow]);
    const shared = choices.find(choice => choice.signature === signature);
    if (shared) shared.types.push(type.id);
    else choices.push({ output, signature, types: [type.id] });
  }
  return choices.sort((a, b) => a.output.overlay!.order - b.output.overlay!.order).map(({ output, types }) => {
    // Keep the existing selector value for queue rejections; its output ID names the ratio.
    const id = category === "BLOCK" && output.id === "queueRejectionRate" ? "queueRejections" : output.id;
    return { ...output,
      types: present === null ? types : types.filter(type => present.has(type)),
      // Keys use the complete catalog so filtered selectors and canvas renderers resolve the same choice.
      key: choices.filter(choice => choice.output.id === output.id).length === 1 ? id : JSON.stringify([id, [...types].sort()]),
    };
  }).filter(output => output.types.length > 0);
}

/** Existing unqualified defaults resolve to the first applicable choice if a new type introduces a collision. */
export const selectedOverlayOutput = (outputs: readonly OverlayOutput[], key?: string) => key === undefined ? outputs[0]
  : outputs.find(output => output.key === key) ?? outputs.find(output => output.id === key);

/** Presentation groups and metric membership come entirely from catalog types. */
export function timelineGroups(catalog: Catalog) {
  const groups = new Map<string, { id: string; title: string; unit: string; scale: number; order: number;
    metrics: { key: string; id: string; label: string; order: number; types: string[] }[] }>();
  for (const type of catalog.types) for (const output of type.outputs ?? []) {
    const timeline = output.timeline;
    if (timeline == null) continue;
    const unit = output.unit === "PER_SECOND" ? "RPS" : output.unit === "MILLISECONDS" ? "ms"
      : output.unit === "PERCENT" ? "%" : output.unit === "MULTIPLIER" ? "×" : "requests";
    const groupId = JSON.stringify([timeline.group, unit]);
    let group = groups.get(groupId);
    if (group === undefined) {
      group = { id: groupId, title: timeline.groupTitle, unit, scale: output.unit === "PERCENT" ? 100 : 1,
        order: timeline.groupOrder, metrics: [] };
      groups.set(groupId, group);
    }
    const metric = group.metrics.find(candidate => candidate.id === output.id && candidate.label === output.title);
    if (metric) metric.types.push(type.id);
    else group.metrics.push({ key: "", id: output.id, label: output.title, order: timeline.order, types: [type.id] });
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map(group => ({
    ...group, metrics: group.metrics.sort((a, b) => a.order - b.order).map(metric => ({
      ...metric, key: JSON.stringify([group.id, metric.id, [...metric.types].sort()]),
    })),
  }));
}

/** Keep actual time bounds while projecting arbitrary catalog outputs. */
export function outputWindow<T extends { startMs: number; durationMs: number }>(outputs: readonly OutputDescriptor[], frame: T): Record<string, number | null> & { startMs: number; durationMs: number } {
  return { ...Object.fromEntries(outputs.map(output => [output.id, calculateOutput(output.calculation, frame)])),
    startMs: frame.startMs, durationMs: frame.durationMs };
}
