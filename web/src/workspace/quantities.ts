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

/** A generated duration uses the largest catalog unit with a whole value; sub-unit values retain their precision. */
export function durationLiteral(milliseconds: number, units: readonly ParamDescriptor["units"][number][]): string {
  const unit = [...units].sort((a, b) => b.numerator / b.denominator - a.numerator / a.denominator)
    .find(unit => milliseconds > 0 && Number.isInteger(milliseconds * unit.denominator / unit.numerator)) ?? units[0];
  return `${milliseconds * unit.denominator / unit.numerator}${unit.symbol}`;
}

function decimal(text: string): [bigint, bigint] {
  const [significand, exponent = "0"] = text.toLowerCase().split("e");
  const [whole, fraction = ""] = significand.split(".");
  return [BigInt(whole + fraction), BigInt(exponent) - BigInt(fraction.length)];
}

function product(...factors: [bigint, bigint][]): string {
  const coefficient = factors.reduce((value, [factor]) => value * factor, 1n);
  if (coefficient === 0n) return "0";
  const digits = coefficient.toString();
  const significant = digits.replace(/0+$/, "");
  const exponent = factors.reduce((value, [, power]) => value + power, BigInt(digits.length - significant.length));
  return `${significant}e${exponent}`;
}

/**
 * Exact decimal equality after unit conversion, without binary rounding or expanding powers of ten.
 * Cross-multiplication also handles catalog scales that are fractions.
 */
export function equivalentQuantities(left: string, right: string, units: readonly ParamDescriptor["units"][number][]): boolean {
  const parts = (text: string) => {
    const match = pattern.exec(text);
    const unit = units.find((candidate) => candidate.symbol === match?.[2]);
    return match === null || unit === undefined || canonicalOf(text, units) === null ? null : {
      value: decimal(match[1]), numerator: decimal(String(unit.numerator)), denominator: decimal(String(unit.denominator)),
    };
  };
  const a = parts(left);
  const b = parts(right);
  return a !== null && b !== null &&
    product(a.value, a.numerator, b.denominator) === product(b.value, b.numerator, a.denominator);
}
