import { expect, it } from "vitest";
import { axisTicks, bandPath, linearScale, sampleBand, samplePoints, stepPath, yDomain } from "./data";
import { colorForKey, seriesColor, timelineColor } from "./palette";

it("scales numeric domains, retains endpoints and produces readable ticks", () => {
  const scale = linearScale([10, 30], [100, 300]);
  expect([scale(10), scale(20), scale(30)]).toEqual([100, 200, 300]);
  expect(axisTicks([0, 70], 6)).toEqual([0, 20, 40, 60, 70]);
  expect(axisTicks([0, 0.3], 4)).toEqual([0, 0.1, 0.2, 0.3]);
  expect(axisTicks([4, 4], 5)).toEqual([4]);
});

it("includes thresholds and range extrema in automatic Y scales, with finite empty and constant domains", () => {
  expect(yDomain([2, 8], { scale: "zero" })).toEqual([0, 8]);
  expect(yDomain([2, 8], { scale: "data" })).toEqual([2, 8]);
  expect(yDomain([-3, 8], { scale: "zero" })).toEqual([-4, 8]);
  expect(yDomain([2, 80], { scale: "manual", min: 10, max: 20 })).toEqual([10, 20]);
  expect(yDomain([], { scale: "data" })).toEqual([0, 1]);
  expect(yDomain([0, 0], { scale: "data" })).toEqual([-1, 1]);
  expect(yDomain([5, 5], { scale: "data" })).toEqual([4, 6]);
  expect(yDomain([null, Number.NaN], { scale: "zero" })).toEqual([0, 1]);
});

it("keeps a zero-only series above the zero baseline", () => {
  expect(yDomain([0, 0], { scale: "zero" })).toEqual([0, 1]);
});

it("closes isolated step values at their window ends without bridging null windows", () => {
  const points = [
    { x: 0, endX: 1, value: 1 }, { x: 1, endX: 2, value: null }, { x: 2, endX: 2.5, value: 3 },
  ];
  expect(stepPath(points, x => x, y => y)).toBe("M0,1H1M2,3H2.5");
  expect(stepPath([{ x: 0, value: 1 }, { x: 1, value: 3 }], x => x, y => y)).toBe("M0,1H1V3");
});

it("closes each stepped range separately and preserves the lower boundary on the return path", () => {
  expect(bandPath([
    { x: 0, endX: 1, range: [1, 4] }, { x: 1, endX: 2, range: [2, 5] },
    { x: 2, endX: 3, range: null }, { x: 3, endX: 4, range: [3, 6] },
  ], x => x, y => y)).toBe("M0,4H1V5H2L2,2H1V1H0ZM3,6H4L4,3H3Z");
});

it("retains extrema and both gap edges at a pixel budget for lines and ranges", () => {
  const points = Array.from({ length: 1000 }, (_, x) => ({ x, value: x === 500 ? null : x === 501 ? 90 : 1,
    range: x === 500 ? null : [x === 502 ? -10 : 0, x === 503 ? 100 : 2] as [number, number] }));
  const line = samplePoints(points, 10, point => point.x);
  expect(line.map(point => point.x)).toEqual(expect.arrayContaining([0, 499, 500, 501, 999]));
  expect(line.length).toBeLessThan(50);
  const band = sampleBand(points, 10, point => point.x);
  expect(band.map(point => point.x)).toEqual(expect.arrayContaining([0, 499, 500, 501, 502, 503, 999]));
  expect(band.length).toBeLessThan(90);
});

it("assigns colors by stable identity or experiment position, independently of visible series", () => {
  const gateway = { elementId: "gateway", outputId: "utilization", variantIndex: 2 };
  const dependency = { elementId: "dependency", outputId: "latency", variantIndex: 0 };
  const colors = [gateway, dependency].map(series => seriesColor(series, "element"));
  expect([dependency, gateway, { elementId: "new" }].map(series => seriesColor(series, "element")).slice(0, 2)).toEqual([...colors].reverse());
  expect(seriesColor({ ...gateway, outputId: "queue" }, "element")).toBe(colors[0]);
  expect(seriesColor({ ...gateway, elementId: "another" }, "metric")).toBe(seriesColor(gateway, "metric"));
  expect(seriesColor({ ...gateway, elementId: "another" }, "variant")).toBe(seriesColor(gateway, "variant"));
  expect(seriesColor(gateway, "variant")).not.toBe(seriesColor(dependency, "variant"));
  expect(colorForKey("gateway")).toBe(colorForKey("gateway"));
  expect(timelineColor("gateway", "offeredPerSecond", false)).not.toBe(timelineColor("gateway-to-middle", "sentAttemptsPerSecond", false));
  const primary = ["gateway", "dependency"].map(id => timelineColor(id, "utilization", false));
  const comparison = ["gateway", "dependency"].map(id => timelineColor(id, "utilization", true));
  expect(primary.some(color => comparison.includes(color))).toBe(false);
});
