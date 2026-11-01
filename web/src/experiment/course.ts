import type { Catalog, ExperimentFile, ModelFile, ParamDescriptor } from "../api/apiTypes";
import { messages, t } from "../i18n";
import { formatMultiplier, formatNumber, formatPercent, formatRate } from "../i18n/format";
import { isObject, ownEntry } from "../workspace/params";
import { canonicalOf } from "../workspace/quantities";
import { formatParameterValue } from "../workspace/parameterValues";
import { elementLabel } from "../presentation/labels";

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
    label: t("course.connection", { from: elementLabel(connection.from + suffix, model), to: elementLabel(connection.to, model) }) };
  return { elementId: replicaExists && block !== undefined && !["client", "router"].includes(block.type) ? id : null, label: elementLabel(target, model) };
}

/** One description for every view; fault kind names stay in the shared faults.kinds catalog. */
export function faultLabel(fault: Fault, model: ModelFile, catalog: Catalog): string {
  const key = `faults.kinds.${fault.kind}`;
  const kind = Object.hasOwn(messages, key) ? t(key) : fault.kind;
  if (fault.kind === "flush") return t("course.fault", {
    target: targetOf(fault.target, model).label, details: kind, interval: formatParameterValue(fault.at),
  });
  const parameters = fault.kind === "slowdown" ? [
    ...(fault.multiplier == null ? [] : [formatMultiplier(fault.multiplier)]),
    ...(fault.delay == null ? [] : [t("course.delay", { delay: formatParameterValue(fault.delay) })]),
  ].join(" ") : fault.kind === "errors" ? formatPercent(quantity(fault.failureRate, catalog, "PROBABILITY")) : "";
  const details = fault.kind === "capacityLoss" ? t("course.capacity", { kind, capacity: formatNumber(fault.capacity) })
    : parameters === "" ? kind : t("course.parameters", { kind, parameters });
  const from = formatParameterValue(fault.from), to = formatParameterValue(fault.to);
  const sameUnit = /[a-z]+$/.exec(fault.from ?? "")?.[0] === /[a-z]+$/.exec(fault.to ?? "")?.[0];
  const combineUnit = sameUnit && from.includes(" ") && quantity(fault.from, catalog, "DURATION") !== null && quantity(fault.to, catalog, "DURATION") !== null;
  const interval = t("course.interval", { from: combineUnit ? from.slice(0, from.lastIndexOf(" ")) : from, to });
  return t("course.fault", { target: targetOf(fault.target, model).label, details, interval });
}

function loadPoints(load: unknown, catalog: Catalog): LoadPoint[] | null {
  if (!isObject(load) || !Array.isArray(load.points) || load.points.length === 0) return null;
  const points: LoadPoint[] = [];
  for (const value of load.points) {
    if (!isObject(value)) return null;
    const timeMs = quantity(value.time, catalog, "DURATION"), rate = quantity(value.rate, catalog, "RATE");
    if (timeMs === null || rate === null || rate < 0 || timeMs <= (points.at(-1)?.timeMs ?? -1)) return null;
    points.push({ timeMs, rate: rate * 1000 });
  }
  return points;
}

function rateAt(points: LoadPoint[], timeMs: number): number {
    const next = points.findIndex(point => point.timeMs > timeMs);
    if (next === 0) return points[0].rate;
    if (next < 0) return points.at(-1)!.rate;
    const left = points[next - 1], right = points[next];
    return left.rate + (right.rate - left.rate) * (timeMs - left.timeMs) / (right.timeMs - left.timeMs);
}

/** Sum on every profile knot, without clipping to the current run duration. Invalid drafts cannot be combined. */
export function sumLoadProfiles(loads: unknown[], catalog: Catalog): { points: { time: string; rate: string }[] } | null {
  const parsed = loads.map(load => loadPoints(load, catalog));
  if (parsed.some(points => points === null)) return null;
  const profiles = parsed as LoadPoint[][];
  const times = [...new Set([0, ...profiles.flatMap(points => points.map(point => point.timeMs))])].sort((a, b) => a - b);
  return { points: times.map(time => ({ time: `${time}ms`, rate: `${profiles.reduce((sum, points) => sum + rateAt(points, time), 0)}/s` })) };
}

/** Interpolate at run boundaries and hold the nearest point outside a valid, increasing profile. */
export function loadCurve(load: unknown, endMs: number, catalog: Catalog): LoadPoint[] {
  const points = loadPoints(load, catalog);
  if (points === null || endMs <= 0) return [];
  const at = (timeMs: number): LoadPoint => ({ timeMs, rate: rateAt(points, timeMs) });
  return [at(0), ...points.filter(point => point.timeMs > 0 && point.timeMs < endMs), at(endMs)];
}

/** Request types keep their document order; a malformed profile leaves the total invalid as well. */
export function clientLoadCurves(params: Record<string, unknown>, endMs: number, catalog: Catalog) {
  const types = Array.isArray(params.classes) ? params.classes.map((value, index) => ({
    id: isObject(value) && typeof value.id === "string" ? value.id : String(index + 1),
    points: loadCurve(isObject(value) ? value.load : undefined, endMs, catalog),
  })) : [];
  const combined = params.classes == null ? params.load : Array.isArray(params.classes)
    ? sumLoadProfiles(params.classes.map(value => isObject(value) ? value.load : undefined), catalog) : null;
  return { points: loadCurve(combined, endMs, catalog), types };
}

/** Read-only document projection; malformed drafts remain visible without inventing valid data. */
export function courseData(model: ModelFile, experiment: ExperimentFile, catalog: Catalog) {
  const warmupMs = quantity(experiment.execution.warmup, catalog, "DURATION") ?? 0;
  const measurementMs = quantity(experiment.execution.measurement, catalog, "DURATION") ?? 0;
  const endMs = warmupMs + measurementMs;
  return {
    warmupMs, endMs,
    loads: Object.entries(model.blocks).filter(([, block]) => block.type === "client")
      .map(([id, block]) => ({ id, ...clientLoadCurves(block.params, endMs, catalog) })),
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
    return data.loads.length === 1 ? value : t("course.clientLoad", { client: elementLabel(load.id, model), value });
  }).join(t("course.listSeparator")) || t("common.na");
  return t("course.conditions", { load: loads, faults: data.faults.map(fault => fault.label).join(t("course.listSeparator")) || t("course.noFaults") });
}
