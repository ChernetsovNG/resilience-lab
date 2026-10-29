import { describe, expect, it } from "vitest";
import { formatDuration, formatInterval, formatMultiplier, formatNumber, formatPercent, formatRate, formatSize } from "./format";

describe("localized display formats", () => {
  it("formats numbers with grouping and without trailing zeroes", () => {
    expect(formatNumber(1200)).toBe("1,200");
    expect(formatNumber(0.125)).toBe("0.13");
    expect(formatNumber(-0.00001)).toBe("0");
  });
  it("formats fractions as percentages without clipping", () => {
    expect(formatPercent(0.657)).toBe("65.7%");
    expect(formatPercent(-0.1)).toBe("-10%");
    expect(formatPercent(1.2)).toBe("120%");
  });
  it("formats milliseconds, seconds, rates and multipliers", () => {
    expect(formatDuration(80)).toBe("80 ms");
    expect(formatDuration(1.23456, "s")).toBe("1.235 s");
    expect(formatRate(1200)).toBe("1,200 RPS");
    expect(formatMultiplier(0.9)).toBe("0.9×");
  });
  it("formats binary sizes consistently, including the MiB boundary", () => {
    expect(formatSize(819200)).toBe("800 KiB");
    expect(formatSize(1048576)).toBe("1 MiB");
    expect(formatSize(1023)).toBe("0.999 KiB");
    expect(formatSize(0)).toBe("0 KiB");
  });
  it("preserves negative confidence bounds and missing values", () => {
    expect(formatInterval(-0.1, 1.2, formatPercent)).toBe("95% CI -10%–120%");
    expect(formatInterval(-2, 5, formatDuration)).toBe("95% CI -2 ms–5 ms");
    expect(formatInterval(null, 5)).toBe("n/a");
    for (const format of [formatNumber, formatPercent, formatDuration, formatRate, formatMultiplier, formatSize]) {
      expect(format(null)).toBe("n/a");
      expect(format(undefined)).toBe("n/a");
    }
  });
});
