import type { ParamDescriptor } from "../api/apiTypes";

const pattern = /^([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)(.+)$/;

/**
 * Canonical value of [text], a finite non-negative number followed by one of [units] such as `250ms` or `120/s`; null
 * for any other text. The units and their scales come from the catalog descriptor of the parameter (ADR 0001), and
 * the arithmetic repeats the core parser, so ranges are checked on the same numbers.
 */
export function canonicalOf(text: string, units: readonly ParamDescriptor["units"][number][]): number | null {
  const match = pattern.exec(text);
  const unit = units.find((candidate) => candidate.symbol === match?.[2]);
  if (match === null || unit === undefined) return null;
  const value = (Number(match[1]) * unit.numerator) / unit.denominator;
  return Number.isFinite(value) ? value : null;
}
