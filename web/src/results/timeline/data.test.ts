import { expect, it } from "vitest";
import { downsample, timelineRegions, windowAt } from "./data";
import { catalog } from "../../test/fixtures";

it("keeps first, last and extrema in time order in each pixel", () => {
  const values = [2, 9, -4, 3, 5, -8, 11, 6].map((value, index) => ({ window: index, startMs: index, value }));
  expect(downsample(values, 2).map((point) => point.value)).toEqual([2, 9, -4, 3, 5, -8, 11, 6]);
  const dense = Array.from({ length: 1000 }, (_, index) => ({ window: index, startMs: index, value: index === 501 ? 90 : 1 }));
  const sampled = downsample(dense, 20);
  expect(sampled.length).toBeLessThanOrEqual(80);
  expect(sampled).toContainEqual({ window: 501, startMs: 501, value: 90 });
  expect(sampled[0].window).toBe(0);
  expect(sampled.at(-1)?.window).toBe(999);
});

it("preserves both edges of missing values and steps rather than joining gaps", () => {
  const values = [1, 1, null, null, 7, 7, 7, null, 2, 2].map((value, index) => ({ window: index, startMs: index, value }));
  const sampled = downsample(values, 1);
  expect(sampled.map((point) => point.window)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
  expect(downsample([], 0)).toEqual([]);
});

it("marks warmup and clipped fault intervals using catalog duration units", () => {
  expect(timelineRegions(100, 1000, [
    { target: "dependency", from: "0.2s", to: "700ms" },
    { target: "gateway", from: "900ms", to: "2s" },
    { target: "outside", from: "2s", to: "3s" },
  ], catalog)).toEqual([
    { fromMs: 0, toMs: 100, label: "Warmup", kind: "warmup" },
    { fromMs: 200, toMs: 700, label: "Fault: dependency", kind: "fault" },
    { fromMs: 900, toMs: 1100, label: "Fault: gateway", kind: "fault" },
  ]);
});

it("maps hover and clicks to original half-open windows including a short final one", () => {
  expect(windowAt(0, 10, 25)).toBe(0);
  expect(windowAt(10, 10, 25)).toBe(1);
  expect(windowAt(24.9, 10, 25)).toBe(2);
  expect(windowAt(25, 10, 25)).toBe(2);
});
