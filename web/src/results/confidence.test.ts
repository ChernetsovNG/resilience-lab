import { describe, expect, it } from "vitest";
import retryStorm from "./fixtures/retry-storm-ci95.json";
import { confidenceInterval, studentTQuantile } from "./confidence";

describe("Student confidence intervals", () => {
  // Two-sided levels 80/90/95/99%; NIST Student table, with unrounded reference values.
  it.each([
    [1, [3.077683537207806, 6.313751514675041, 12.706204736174705, 63.65674116287399]],
    [2, [1.88561808316415, 2.919985580355516, 4.302652729696142, 9.92484320091807]],
    [4, [1.533206274058943, 2.13184678632665, 2.7764451051977987, 4.604094871415897]],
    [9, [1.38302873839649, 1.8331129326536335, 2.2621571628540993, 3.2498355415921254]],
    [29, [1.31143364730155, 1.6991270265334972, 2.045229642132703, 2.756385903670335]],
  ])("matches critical values at df=%s within 1e-6 relative error", (df, expected) => {
    [0.9, 0.95, 0.975, 0.995].forEach((probability, index) => {
      expect(Math.abs(studentTQuantile(probability, df) / expected[index] - 1)).toBeLessThan(1e-6);
    });
  });

  it("retains symmetry and approaches the normal limit without dropping the Student correction", () => {
    expect(studentTQuantile(0.025, 29)).toBeCloseTo(-2.045229642132703, 8);
    expect(studentTQuantile(0.5, 29)).toBe(0);
    expect(studentTQuantile(0.995, 1000)).toBeCloseTo(2.580754698065942, 7);
  });

  it("reproduces stored 95% bounds of the retry-storm fixture", () => {
    for (const variant of retryStorm.variants) for (const metric of Object.values(variant.replicationMetricSummary)) {
      for (const value of [metric.exact, metric.approximate]) {
        const interval = confidenceInterval({ ...value, count: retryStorm.replications }, 95)!;
        expect(interval[0]).toBeCloseTo(value.ci95Low, 6);
        expect(interval[1]).toBeCloseTo(value.ci95High, 6);
      }
    }
  });

  it("reproduces 95% bounds when only two of three replications contribute", () => {
    const metric = { count: 2, mean: 0.375, stdDev: 0.1767766952966369,
      ci95Low: -1.213275592021838, ci95High: 1.963275592021838 };
    const interval = confidenceInterval(metric, 95)!;
    expect(interval[0]).toBeCloseTo(metric.ci95Low, 6);
    expect(interval[1]).toBeCloseTo(metric.ci95High, 6);
  });

  it.each([0, 1])("omits intervals with count=%s without enough observations", count => {
    expect(confidenceInterval({ count, mean: 0.5, stdDev: 0 }, 95)).toBeNull();
  });

  it("widens with confidence and never clips bounds to the physical range", () => {
    const metric = { count: 2, mean: 0.5, stdDev: 0.2 };
    const narrow = confidenceInterval(metric, 80)!;
    const normal = confidenceInterval(metric, 95)!;
    const wide = confidenceInterval(metric, 99)!;
    expect(wide[0]).toBeLessThan(normal[0]);
    expect(normal[0]).toBeLessThan(narrow[0]);
    expect(wide[1]).toBeGreaterThan(normal[1]);
    expect(normal[1]).toBeGreaterThan(narrow[1]);
    expect(normal[0]).toBeLessThan(0);
    expect(normal[1]).toBeGreaterThan(1);
    expect(confidenceInterval({ count: 2, mean: 5, stdDev: 0 }, 99)).toEqual([5, 5]);
  });

  it.each([
    [null, 2], [{ mean: 0.5 }, 2], [{ mean: 0.5, stdDev: null }, 2],
    [{ mean: 0.5, stdDev: 0.2 }, 1], [{ mean: 0.5, stdDev: 0.2 }, 0],
    [{ mean: null, stdDev: 0.2 }, 2], [{ mean: NaN, stdDev: 0.2 }, 2],
    [{ mean: 0.5, stdDev: 0.2 }, -1], [{ mean: 0.5, stdDev: 0.2 }, 2.5],
    [{ mean: 0.5, stdDev: 0.2 }, NaN], [{ mean: 0.5, stdDev: 0.2 }, Infinity],
    [{ mean: 0.5, stdDev: Infinity }, 2], [{ mean: 0.5, stdDev: -1 }, 2],
  ])("omits uncertainty without valid mean, spread and observation count (%j, %s)", (metric, n) => {
    expect(confidenceInterval(metric === null ? null : { ...metric, count: n }, 95)).toBeNull();
  });
});
