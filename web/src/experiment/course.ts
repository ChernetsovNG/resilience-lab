import type { Catalog, ExperimentFile, ModelFile, ParamDescriptor } from "../api/apiTypes";
import { messages, t } from "../i18n";
import { formatDuration, formatMultiplier, formatNumber, formatPercent, formatRate } from "../i18n/format";
import { isObject, ownEntry } from "../workspace/params";
import { canonicalOf } from "../workspace/quantities";

type Fault = ExperimentFile["faults"][number];
export interface LoadPoint { timeMs: number; rate: number }
export interface CourseFault {
  index: number;
  elementId: string | null;
  target: string;
  label: string;
  fromMs: number | null;
  toMs: number | null;
}

function units(catalog: Catalog, dimension: string): ParamDescriptor["units"] {
  const flatten = (fields: ParamDescriptor[]): ParamDescriptor[] => fields.flatMap(field => [field, ...flatten(field.fields)]);
  return flatten(catalog.types.flatMap(type => type.params)).find(field => field.dimension === dimension)?.units ?? [];
}

function quantity(value: unknown, catalog: Catalog, dimension: string): number | null {
  return typeof value === "string" ? canonicalOf(value, units(catalog, dimension)) : null;
}

function targetOf(target: string, model: ModelFile): { elementId: string | null; label: string } {
  const replica = /^(.*)(#[1-9][0-9]*)$/.exec(target);
  const exact = Object.hasOwn(model.blocks, target) || model.connections.some(connection => connection.id === target);
  const id = exact ? target : replica?.[1] ?? target;
  const suffix = exact ? "" : replica?.[2] ?? "";
  const connection = model.connections.find(connection => connection.id === id);
  const block = ownEntry(model.blocks, connection?.from ?? id);
  const count = block?.params.replicas ?? 1;
  const replicaExists = suffix === "" || (typeof count === "number" && Number.isInteger(count) && count > 1 && Number(suffix.slice(1)) <= count);
  if (connection !== undefined) return { elementId: replicaExists && ["call", "route"].includes(connection.type) ? id : null,
    label: t("course.connection", { from: connection.from + suffix, to: connection.to }) };
  return { elementId: replicaExists && block !== undefined && !["client", "router"].includes(block.type) ? id : null, label: target };
}

/** One description for every view; fault kind names stay in the shared faults.kinds catalog. */
export function faultLabel(fault: Fault, model: ModelFile, catalog: Catalog): string {
  const key = `faults.kinds.${fault.kind}`;
  const kind = Object.hasOwn(messages, key) ? t(key) : fault.kind;
  const parameters = fault.kind === "slowdown" ? [
    ...(fault.multiplier == null ? [] : [formatMultiplier(fault.multiplier)]),
    ...(fault.delay == null ? [] : [t("course.delay", { delay: formatDuration(quantity(fault.delay, catalog, "DURATION")) })]),
  ].join(" ") : fault.kind === "errors" ? formatPercent(quantity(fault.failureRate, catalog, "PROBABILITY")) : "";
  const details = fault.kind === "capacityLoss" ? t("course.capacity", { kind, capacity: formatNumber(fault.capacity) })
    : parameters === "" ? kind : t("course.parameters", { kind, parameters });
  const from = quantity(fault.from, catalog, "DURATION"), to = quantity(fault.to, catalog, "DURATION");
  const interval = t("course.interval", {
    from: from === null ? fault.from : formatNumber(from / 1000, 3),
    to: to === null ? fault.to : formatDuration(to / 1000, "s"),
  });
  return t("course.fault", { target: targetOf(fault.target, model).label, details, interval });
}

/** Interpolate at run boundaries and hold the nearest point outside a valid, increasing profile. */
function loadCurve(load: unknown, endMs: number, catalog: Catalog): LoadPoint[] {
  if (!isObject(load) || !Array.isArray(load.points) || load.points.length === 0 || endMs <= 0) return [];
  const points: LoadPoint[] = [];
  for (const value of load.points) {
    if (!isObject(value)) return [];
    const timeMs = quantity(value.time, catalog, "DURATION"), rate = quantity(value.rate, catalog, "RATE");
    if (timeMs === null || rate === null || timeMs <= (points.at(-1)?.timeMs ?? -1)) return [];
    points.push({ timeMs, rate: rate * 1000 });
  }
  const at = (timeMs: number): LoadPoint => {
    const next = points.findIndex(point => point.timeMs > timeMs);
    if (next === 0) return { timeMs, rate: points[0].rate };
    if (next < 0) return { timeMs, rate: points.at(-1)!.rate };
    const left = points[next - 1], right = points[next];
    return { timeMs, rate: left.rate + (right.rate - left.rate) * (timeMs - left.timeMs) / (right.timeMs - left.timeMs) };
  };
  return [at(0), ...points.filter(point => point.timeMs > 0 && point.timeMs < endMs), at(endMs)];
}

/** Read-only document projection; malformed drafts remain visible without inventing valid data. */
export function courseData(model: ModelFile, experiment: ExperimentFile, catalog: Catalog) {
  const warmupMs = quantity(experiment.execution.warmup, catalog, "DURATION") ?? 0;
  const measurementMs = quantity(experiment.execution.measurement, catalog, "DURATION") ?? 0;
  const endMs = warmupMs + measurementMs;
  return {
    warmupMs, endMs,
    loads: Object.entries(model.blocks).filter(([, block]) => block.type === "client")
      .map(([id, block]) => ({ id, points: loadCurve(block.params.load, endMs, catalog) })),
    faults: experiment.faults.map((fault, index): CourseFault => ({
      index, elementId: targetOf(fault.target, model).elementId, target: targetOf(fault.target, model).label,
      label: faultLabel(fault, model, catalog),
      fromMs: quantity(fault.from, catalog, "DURATION"), toMs: quantity(fault.to, catalog, "DURATION"),
    })),
  };
}

/** Conditions describe the supplied document snapshot, including overrides already applied by the caller. */
export function runConditions(model: ModelFile, experiment: ExperimentFile, catalog: Catalog): string {
  const data = courseData(model, experiment, catalog);
  const loads = data.loads.map(load => {
    const rates = load.points.map(point => point.rate);
    const low = Math.min(...rates), high = Math.max(...rates);
    const value = rates.length === 0 ? t("common.na") : low === high ? formatRate(low)
      : t("course.loadRange", { from: formatRate(low), to: formatRate(high) });
    return data.loads.length === 1 ? value : t("course.clientLoad", { client: load.id, value });
  }).join(t("course.listSeparator")) || t("common.na");
  return t("course.conditions", { load: loads, faults: data.faults.map(fault => fault.label).join(t("course.listSeparator")) || t("course.noFaults") });
}
