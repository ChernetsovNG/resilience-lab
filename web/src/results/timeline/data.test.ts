import { expect, it } from "vitest";
import { downsample, replicaBand, timelineRegions, windowAt } from "./data";
import { catalog } from "../../test/fixtures";

it("builds the replica band from recorded bounds, scales it and closes segments before gaps", () => {
  const windows = [
    { startMs: 0, durationMs: 10, min: 0.02, max: 0.97 },
    { startMs: 10, durationMs: 10, min: null, max: null },
    { startMs: 20, durationMs: 5, min: 0.1, max: 0.4 },
  ];
  expect(replicaBand(windows, ["min", "max"], 100, 100)).toEqual([
    { window: 0, startMs: 0, range: [2, 97] },
    { window: 0, startMs: 10, range: [2, 97] },
    { window: 1, startMs: 10, range: null },
    { window: 2, startMs: 20, range: [10, 40] },
    { window: 2, startMs: 25, range: [10, 40] },
  ]);
});

it("preserves peaks of both replica bounds when reducing a dense band", () => {
  const windows = Array.from({ length: 1000 }, (_, index) => ({ startMs: index, durationMs: 1,
    min: index === 501 ? 0.01 : 0.2, max: index === 502 ? 0.99 : 0.5 }));
  const band = replicaBand(windows, ["min", "max"], 100, 20);
  expect(band.length).toBeLessThan(160);
  expect(band).toContainEqual({ window: 501, startMs: 501, range: [1, 50] });
  expect(band).toContainEqual({ window: 502, startMs: 502, range: [20, 99] });
  expect(band.at(-1)).toEqual({ window: 999, startMs: 1000, range: [20, 50] });
});

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
    { target: "dependency", from: "0.2s", to: "700ms", kind: "slowdown", multiplier: 2 },
    { target: "gateway", from: "900ms", to: "2s", kind: "unavailable" },
    { target: "outside", from: "2s", to: "3s", kind: "blackhole" },
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
