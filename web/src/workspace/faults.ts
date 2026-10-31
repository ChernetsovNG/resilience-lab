import type { Catalog, ExperimentFile, ModelFile } from "../api/apiTypes";
import { isObject, ownEntry } from "./params";
import { canonicalOf } from "./quantities";

type Fault = ExperimentFile["faults"][number];
export const faultKinds = ["slowdown", "errors", "unavailable", "blackhole", "capacityLoss"] as const;
/** Native menus stay bounded; a separate number field can address every remaining replica. */
export const MAX_LISTED_FAULT_REPLICAS = 100;

export interface FaultTarget {
  id: string;
  elementId: string;
  type: string;
  connection: boolean;
  capacity: number | null;
  replicas: number;
}

/** Document targets and expanded instance addresses, using the same source-replica suffix as the compiler. */
export function faultTargets(model: ModelFile, catalog: Catalog, selected: readonly string[] = []): FaultTarget[] {
  const parameter = (type: string, name: string) => catalog.types.find(candidate => candidate.id === type)?.params.find(param => param.name === name);
  const countOf = (id: string) => {
    const block = ownEntry(model.blocks, id);
    const count = block?.type === "service" ? block.params.replicas ?? parameter("service", "replicas")?.default ?? 1 : 1;
    return typeof count === "number" && Number.isSafeInteger(count) && count > 1 ? count : 1;
  };
  const capacityOf = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  const indices = (id: string, count: number) => [...new Set([
    ...Array.from({ length: Math.min(count, MAX_LISTED_FAULT_REPLICAS) }, (_, index) => index + 1),
    ...selected.filter(target => target.startsWith(id + "#")).map(target => Number(target.slice(id.length + 1)))
      .filter(index => Number.isSafeInteger(index) && index >= 1 && index <= count),
  ])];
  const blocks = Object.entries(model.blocks).flatMap(([id, block]): FaultTarget[] => {
    const name = ({ service: "handlers", database: "maxConnections", pooler: "poolSize" } as Record<string, string>)[block.type];
    if (name === undefined) return [];
    const capacity = capacityOf(block.params[name] ?? parameter(block.type, name)?.default);
    const count = countOf(id);
    const target = { id, elementId: id, type: block.type, connection: false, capacity, replicas: count };
    if (count === 1) return [target];
    const overrides = Object.keys(block.replicaOverrides ?? {}).filter(key => Number.isSafeInteger(Number(key)) &&
      Number(key) >= 1 && Number(key) <= count && String(Number(key)) === key);
    const capacities = overrides.map(key => capacityOf(block.replicaOverrides![key][name] ?? capacity));
    const groupCapacity = capacities.reduce<number | null>((minimum, value) =>
      minimum === null || value === null ? null : Math.min(minimum, value), overrides.length < count ? capacity : capacities[0]);
    return [{ ...target, capacity: groupCapacity }, ...indices(id, count).map(index => ({ ...target, id: `${id}#${index}`,
      capacity: capacityOf(block.replicaOverrides?.[String(index)]?.[name] ?? capacity) }))];
  });
  const connections = model.connections.flatMap((connection): FaultTarget[] => {
    if (connection.type !== "call" && connection.type !== "route") return [];
    const pool = connection.params.pool;
    const capacity = connection.type === "call" && ownEntry(model.blocks, connection.from)?.type !== "pooler" && isObject(pool)
      ? capacityOf(pool.size) : null;
    const count = countOf(connection.from);
    const target = { id: connection.id, elementId: connection.id, type: connection.type, connection: true, capacity, replicas: count };
    return [target, ...(count === 1 ? [] : indices(connection.id, count).map(index => ({ ...target, id: `${connection.id}#${index}` })))];
  });
  return [...blocks, ...connections];
}

/** Faults have no descriptors in the catalog, so their initial values are defined here. */
const INITIAL_FAULT_FIELDS = { slowdown: { multiplier: 2 }, errors: { failureRate: "50%" } } as const;

/** Capacity loss starts at half the effective slot pool; other kinds use explicit fault defaults. */
export function initialFaultFields(kind: string, target?: FaultTarget): Partial<Fault> {
  if (kind === "slowdown" || kind === "errors") return { ...INITIAL_FAULT_FIELDS[kind] };
  if (kind === "capacityLoss") return { capacity: Math.floor((target?.capacity ?? 0) / 2) };
  return {};
}

/** Create a valid shared slowdown inside the measurement interval, using the catalog's duration scale. */
export function createFault(catalog: Catalog, experiment: ExperimentFile, target: FaultTarget): Fault | null {
  const units = catalog.types.flatMap(type => type.params).find(param => param.dimension === "DURATION")?.units ?? [];
  const unit = units[0];
  const measurement = canonicalOf(experiment.execution.measurement, units);
  const warmup = canonicalOf(experiment.execution.warmup, units);
  if (unit === undefined || measurement === null || measurement <= 0 || warmup === null || warmup < 0) return null;
  const time = (fraction: number) => `${((warmup + measurement * fraction) * unit.denominator) / unit.numerator}${unit.symbol}`;
  return { target: target.id, from: time(0.5), to: time(0.75), kind: "slowdown", ...initialFaultFields("slowdown", target) };
}
