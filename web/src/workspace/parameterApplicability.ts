import type { ParamDescriptor } from "../api/apiTypes";
import { parseParam } from "./paramParsing";
import { isObject, type Params } from "./params";

/** Conditions address a sibling, resolving an omitted controlling value through its catalog default. */
export function parameterApplies(descriptor: ParamDescriptor, values: Params, siblings: readonly ParamDescriptor[]): boolean {
  const rule = descriptor.appliesWhen;
  return rule == null || rule.values.includes(String(values[rule.field] ?? siblings.find(field => field.name === rule.field)?.default));
}

/** Reconcile dependent fields only when their controlling value changes, as part of the caller's single history entry. */
export function reconcileParameter(descriptor: ParamDescriptor, previous: unknown, value: unknown): unknown {
  if (descriptor.kind !== "OBJECT" || !isObject(value)) return value;
  const before = isObject(previous) ? previous : isObject(descriptor.default) ? descriptor.default : {};
  const next = { ...value };
  const fields = descriptor.fields;
  const changed = fields.some(field => {
    const controller = field.appliesWhen?.field;
    const fallback = fields.find(sibling => sibling.name === controller)?.default;
    return controller !== undefined && (before[controller] ?? fallback) !== (next[controller] ?? fallback);
  });
  if (changed) {
    const deviation = fields.find(field => field.name === "stdDev" && field.appliesWhen != null);
    // Random duration distributions require a positive mean, including network/pooler defaults of zero.
    if (deviation !== undefined && next.kind !== "fixed" && !parseParam({ ...deviation, required: true }, String(next.mean ?? "")).ok) {
      const initial = fields.find(field => field.name === "mean")?.initial;
      next.mean = initial != null && parseParam(deviation, String(initial)).ok ? initial : "1ms";
    }
    for (const field of fields) {
      if (!parameterApplies(field, next, fields)) delete next[field.name];
      else if (!parameterApplies(field, before, fields) && next[field.name] == null) {
        const initial = field.initial ?? field.default ?? (field === deviation ? next.mean : undefined);
        if (initial != null) next[field.name] = structuredClone(initial);
      }
    }
  }
  for (const field of fields) {
    if (isObject(next[field.name])) next[field.name] = reconcileParameter(field, before[field.name], next[field.name]);
  }
  return JSON.stringify(next) === JSON.stringify(value) ? value : next;
}
