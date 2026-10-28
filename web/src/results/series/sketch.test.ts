import { describe, expect, it } from "vitest";
import golden from "./fixtures/retry-storm-baseline-rep-0.json";
import { LatencySketch } from "./sketch";

const view = new DataView(new ArrayBuffer(8));

function bits(value: number | null): string | null {
  if (value === null) return null;
  view.setFloat64(0, value);
  return view.getUint32(0).toString(16).padStart(8, "0") + view.getUint32(4).toString(16).padStart(8, "0");
}

describe("latency sketch", () => {
  it("matches every retry-storm quantile bit produced by the core", () => {
    const expected = new Map(golden.quantiles.map((value) => [
      `${value.node}/${value.window}`,
      { p50: value.p50 ?? null, p95: value.p95 ?? null, p99: value.p99 ?? null },
    ]));
    expect(expected.size).toBe(400);

    for (const node of golden.part.nodes) {
      for (const [window, metrics] of node.windows.entries()) {
        const sketch = LatencySketch.decode(golden.part.profile, metrics.latency.sketch);
        expect({
          p50: bits(sketch.quantile(0.50)),
          p95: bits(sketch.quantile(0.95)),
          p99: bits(sketch.quantile(0.99)),
        }, `${node.id}/${window}`).toEqual(expected.get(`${node.id}/${window}`));
      }
    }
  });

  it("rejects a different wire profile", () => {
    expect(() => LatencySketch.decode("other", [0])).toThrow("Unsupported sketch profile: other");
  });

  it("rejects unsorted bins", () => {
    expect(() => LatencySketch.decode(golden.part.profile, [0, 64, 1, 0, 1])).toThrow("Invalid or unsorted sketch index");
  });
});
