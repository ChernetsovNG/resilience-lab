import { language, t } from "./index";

type Value = number | null | undefined;
const missing = (value: Value): value is null | undefined => value == null || !Number.isFinite(value);

/** Display precision is shared by quantity kind, without insignificant trailing zeroes. */
export function formatNumber(value: Value, maximumFractionDigits = 2): string {
  if (missing(value)) return t("common.na");
  const number = new Intl.NumberFormat(language, { maximumFractionDigits });
  const rounded = number.format(value);
  return rounded === number.format(-0) ? number.format(0) : rounded;
}

/** Fractions and Student confidence bounds retain their full physical or nonphysical range. */
export function formatPercent(value: Value): string {
  if (missing(value)) return t("common.na");
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const rounded = percent.format(value);
  return rounded === percent.format(-0) ? percent.format(0) : rounded;
}

/** The caller selects the input unit explicitly; no document quantity is rewritten. */
export function formatDuration(value: Value, unit: "ms" | "s" = "ms"): string {
  return missing(value) ? t("common.na") : t(unit === "ms" ? "common.durationMs" : "common.durationS", {
    value: formatNumber(value, unit === "ms" ? 1 : 3),
  });
}

export function formatRate(value: Value): string {
  return missing(value) ? t("common.na") : t("common.rate", { value: formatNumber(value) });
}

export function formatMultiplier(value: Value): string {
  return missing(value) ? t("common.na") : t("common.multiplier", { value: formatNumber(value) });
}

export function formatSize(bytes: Value): string {
  if (missing(bytes)) return t("common.na");
  const mebibytes = Math.abs(bytes) >= 1024 ** 2;
  return t(mebibytes ? "common.sizeMiB" : "common.sizeKiB", {
    value: formatNumber(bytes / (mebibytes ? 1024 ** 2 : 1024), 3),
  });
}

export function formatInterval(low: Value, high: Value, format: (value: number) => string = formatNumber): string {
  return missing(low) || missing(high) ? t("common.na") : t("common.interval", { low: format(low), high: format(high) });
}
