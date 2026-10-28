import type { ParamDescriptor } from "../api/apiTypes";
import { canonicalOf } from "./quantities";

export type ParsedParam = { ok: true; value: unknown } | { ok: false; message: string };

export function parseParam(descriptor: ParamDescriptor, draft: string, checkRange = true): ParsedParam {
  const text = draft.trim();
  if (text === "") return descriptor.required ? { ok: false, message: "Required" } : { ok: true, value: undefined };
  switch (descriptor.kind) {
    case "INTEGER":
      return Number.isSafeInteger(Number(text)) ? inRange(descriptor, Number(text), Number(text), checkRange) : { ok: false, message: "Enter a whole number" };
    case "NUMBER":
      return Number.isFinite(Number(text)) ? inRange(descriptor, Number(text), Number(text), checkRange) : { ok: false, message: "Enter a number" };
    case "QUANTITY": {
      if (descriptor.units.length === 0) return { ok: true, value: text };
      const canonical = canonicalOf(text, descriptor.units);
      return canonical === null
        ? { ok: false, message: `Use a value with a unit: ${descriptor.units.map((unit) => unit.symbol).join(", ")}` }
        : inRange(descriptor, canonical, text, checkRange);
    }
    default:
      return { ok: true, value: text };
  }
}

/** Accepts [value] when its [canonical] number lies in the catalog range, which is in canonical units as in the core.
 * Draft parsing may skip range checks so the core can diagnose the resulting document. */
function inRange(descriptor: ParamDescriptor, canonical: number, value: unknown, checkRange: boolean): ParsedParam {
  const { minimum, exclusiveMinimum, maximum } = descriptor;
  const below = (minimum != null && canonical < minimum) || (exclusiveMinimum != null && canonical <= exclusiveMinimum);
  const above = maximum != null && canonical > maximum;
  if (!checkRange || (!below && !above)) return { ok: true, value };
  const unit = descriptor.units[0];
  const shown = (bound: number) => (unit === undefined ? String(bound) : `${(bound * unit.denominator) / unit.numerator}${unit.symbol}`);
  const limits = [
    minimum == null ? null : `>= ${shown(minimum)}`,
    exclusiveMinimum == null ? null : `> ${shown(exclusiveMinimum)}`,
    maximum == null ? null : `<= ${shown(maximum)}`,
  ];
  return { ok: false, message: `Out of range: ${limits.filter((limit) => limit !== null).join(" and ")}` };
}
