import { describe, expect, it } from "vitest";
import { model, summary } from "../test/fixtures";
import { canvasResults } from "./canvasResults";

function fixture() {
  const run = structuredClone(summary);
  const point = run.variants[0].points[0];
  point.aggregate.services.middle = {
    admittedAmplification: { mean: 2.5, min: 2, max: 3 },
    totals: {
      ...point.aggregate.services.gateway.totals,
      busyHandlerTimeMs: 400, handlerCapacityTimeMs: 500,
      queueLengthIntegralMs: 750, measurementMs: 3000,
      queueRejections: 25, offeredAttempts: 100,
    },
  };
  return run;
}

describe("canvasResults", () => {
  it("uses pooled time and count totals, with amplification from the called service", () => {
    const result = canvasResults(fixture(), model, "baseline", "p0")!;
    expect(result.services.get("gateway")).toEqual({
      utilization: 0.5, meanQueue: 0.1, queueRejectionRate: 20 / 260, firstSaturation: null,
    });
    expect(result.services.get("middle")).toEqual({
      utilization: 0.8, meanQueue: 0.25, queueRejectionRate: 0.25, firstSaturation: null,
    });
    expect(result.connections.get("gateway-to-middle")).toEqual({
      from: "gateway", to: "middle", type: "call", amplification: 2.5,
    });
    expect(result.connections.get("client-to-gateway")?.amplification).toBe(1.2);
    expect(result.services.has("client")).toBe(false);
    expect(result.services.has("dependency")).toBe(false);
    expect(result.connections.has("middle-to-dependency")).toBe(false);
    expect(result.connections.has("new-call")).toBe(false);
  });

  it("selects the requested variant and point without silently falling back", () => {
    const run = fixture();
    const point = structuredClone(run.variants[0].points[0]);
    point.id = "p1";
    point.aggregate.services.gateway.totals.busyHandlerTimeMs = 1500;
    run.variants[0].points.push(point);
    expect(canvasResults(run, model, "baseline", "p1")?.services.get("gateway")?.utilization).toBe(0.75);
    expect(canvasResults(run, model, "no-retries", "p0")?.services.size).toBe(0);
    expect(canvasResults(run, model, "baseline", "p2")).toBeNull();
    expect(canvasResults(run, model, "new-variant", "p0")).toBeNull();
  });

  it("keeps unavailable metrics distinct from zero", () => {
    const run = fixture();
    const service = run.variants[0].points[0].aggregate.services.gateway;
    service.admittedAmplification = null;
    service.totals = {
      ...service.totals, handlerCapacityTimeMs: 0, measurementMs: 0, offeredAttempts: 0,
    };
    const result = canvasResults(run, model, "baseline", "p0")!;
    expect(result.services.get("gateway")).toEqual({
      utilization: null, meanQueue: null, queueRejectionRate: null, firstSaturation: null,
    });
    expect(result.connections.get("client-to-gateway")?.amplification).toBeNull();
    const middle = run.variants[0].points[0].aggregate.services.middle;
    middle.totals.busyHandlerTimeMs = 0;
    middle.totals.queueLengthIntegralMs = 0;
    middle.totals.queueRejections = 0;
    expect(canvasResults(run, model, "baseline", "p0")?.services.get("middle")).toMatchObject({
      utilization: 0, meanQueue: 0, queueRejectionRate: 0,
    });
  });

  it("uses only the first node ranked by core, preserving its tie order", () => {
    const run = fixture();
    const saturation = run.variants[0].points[0].saturation;
    saturation.firstNodes = [
      { node: "middle", replicationCount: 1, medianStartMs: 200, minStartMs: 200, maxStartMs: 200 },
      { node: "gateway", replicationCount: 1, medianStartMs: 300, minStartMs: 300, maxStartMs: 300 },
    ];
    const result = canvasResults(run, model, "baseline", "p0")!;
    expect(result.services.get("middle")?.firstSaturation).toBe("1 of 2 replications");
    expect(result.services.get("gateway")?.firstSaturation).toBeNull();
    saturation.firstNodes = [];
    expect(canvasResults(run, model, "baseline", "p0")?.services.get("middle")?.firstSaturation).toBeNull();
  });

  it("does not read inherited records as service data", () => {
    const snapshot = { ...model, blocks: { ["constructor"]: model.blocks.gateway }, connections: [] };
    expect(canvasResults(summary, snapshot, "baseline", "p0")?.services.size).toBe(0);
  });
});
