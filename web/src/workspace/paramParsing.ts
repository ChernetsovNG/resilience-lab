import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { ParamDescriptor } from "../api/apiTypes";
import { canonicalOf } from "./quantities";
import { formatParameterValue } from "./parameterValues";

export type ParsedParam = { ok: true; value: unknown } | { ok: false; message: string };

export function parseParam(descriptor: ParamDescriptor, draft: string, checkRange = true): ParsedParam {
  const text = draft.trim();
  if (text === "") return descriptor.required ? { ok: false, message: t("editor.param.required") } : { ok: true, value: undefined };
  switch (descriptor.kind) {
    case "INTEGER":
      return Number.isSafeInteger(Number(text)) ? inRange(descriptor, Number(text), Number(text), checkRange) : { ok: false, message: t("editor.param.enterInteger") };
    case "NUMBER":
      return Number.isFinite(Number(text)) ? inRange(descriptor, Number(text), Number(text), checkRange) : { ok: false, message: t("editor.param.enterNumber") };
    case "QUANTITY": {
      if (descriptor.units.length === 0) return { ok: true, value: text };
      const canonical = canonicalOf(text, descriptor.units);
      return canonical === null
        ? { ok: false, message: t("editor.param.useUnit", { units: descriptor.units.map((unit) => unit.symbol).join(t("editor.param.unitSeparator")),
          example: descriptor.dimension === "DURATION" ? "250ms" : descriptor.dimension === "RATE" ? "100/s" : "10%" }) }
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
  const shown = (bound: number) => unit === undefined ? formatNumber(bound) : descriptor.dimension === "DURATION"
    ? formatParameterValue(`${bound * unit.denominator / unit.numerator}${unit.symbol}`, descriptor)
    : t("editor.param.rangeQuantity", { value: formatNumber((bound * unit.denominator) / unit.numerator), unit: unit.symbol });
  const limits = [
    minimum == null ? null : t("editor.param.minimum", { value: shown(minimum) }),
    exclusiveMinimum == null ? null : t("editor.param.exclusiveMinimum", { value: shown(exclusiveMinimum) }),
    maximum == null ? null : t("editor.param.maximum", { value: shown(maximum) }),
  ];
  return { ok: false, message: t("editor.param.outOfRange", { limits: limits.filter((limit) => limit !== null).join(t("editor.param.rangeAnd")) }) };
}
