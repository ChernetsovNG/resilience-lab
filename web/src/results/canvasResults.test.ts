import { describe, expect, it } from "vitest";
import { recordedWindow } from "../test/series";
import { catalog, experiment, experimentPath, layout, layoutPath, model, modelPath, summary } from "../test/fixtures";
import { editorReducer, initialEditorState, setModelParam } from "../workspace/editor";
import { addBlock, addConnection, deleteElements, renameElement } from "../workspace/structure";
import { canvasResults, windowCanvasResults } from "./canvasResults";

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

it("uses the catalog's disabled-queue default when run parameters omit capacity", () => {
  const snapshot = structuredClone(model);
  delete snapshot.blocks.gateway.params.queue;
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, snapshot, experiment)?.services.get("gateway")?.params.queue).toBe(0);
  expect(canvasResults(summary, snapshot, "missing-variant", "p0", catalog, snapshot, experiment)).toBeNull();
});

describe("canvasResults", () => {
  it("uses pooled time and count totals, with amplification from the called service", () => {
    const result = canvasResults(fixture(), model, "baseline", "p0", catalog)!;
    expect(result.services.get("gateway")?.values).toEqual({
      utilization: 0.5, meanQueue: 0.1, queueRejectionRate: 20 / 260,
    });
    expect(result.services.get("middle")?.values).toEqual({
      utilization: 0.8, meanQueue: 0.25, queueRejectionRate: 0.25,
    });
    expect(result.connections.get("gateway-to-middle")).toMatchObject({
      from: "gateway", to: "middle", type: "call", values: { amplification: 2.5 },
    });
    expect(result.connections.get("client-to-gateway")?.values.amplification).toBe(1.2);
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
    expect(canvasResults(run, model, "baseline", "p1", catalog)?.services.get("gateway")?.values.utilization).toBe(0.75);
    expect(canvasResults(run, model, "no-retries", "p0", catalog)?.services.size).toBe(0);
    expect(canvasResults(run, model, "baseline", "p2", catalog)).toBeNull();
    expect(canvasResults(run, model, "new-variant", "p0", catalog)).toBeNull();
  });

  it("keeps unavailable metrics distinct from zero", () => {
    const run = fixture();
    const service = run.variants[0].points[0].aggregate.services.gateway;
    service.admittedAmplification = null;
    service.totals = {
      ...service.totals, handlerCapacityTimeMs: 0, measurementMs: 0, offeredAttempts: 0,
    };
    const result = canvasResults(run, model, "baseline", "p0", catalog)!;
    expect(result.services.get("gateway")?.values).toEqual({
      utilization: null, meanQueue: null, queueRejectionRate: null,
    });
    expect(result.connections.get("client-to-gateway")?.values.amplification).toBeNull();
    const middle = run.variants[0].points[0].aggregate.services.middle;
    middle.totals.busyHandlerTimeMs = 0;
    middle.totals.queueLengthIntegralMs = 0;
    middle.totals.queueRejections = 0;
    expect(canvasResults(run, model, "baseline", "p0", catalog)?.services.get("middle")?.values).toMatchObject({
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
    const result = canvasResults(run, model, "baseline", "p0", catalog)!;
    expect(result.services.get("middle")?.firstSaturation).toBe("1 of 2 replications");
    expect(result.services.get("gateway")?.firstSaturation).toBeNull();
    saturation.firstNodes = [];
    expect(canvasResults(run, model, "baseline", "p0", catalog)?.services.get("middle")?.firstSaturation).toBeNull();
  });

  it("does not read inherited records as service data", () => {
    const snapshot = { ...model, blocks: { ["constructor"]: model.blocks.gateway }, connections: [] };
    expect(canvasResults(summary, snapshot, "baseline", "p0", catalog)?.services.size).toBe(0);
  });
});

function openEditor() {
  return editorReducer(initialEditorState, { type: "open", loaded: {
    model, layout, experiment, modelPath, layoutPath, experimentPath,
    saved: { model, layout, experiment }, versions: { model: "m", layout: "l", experiment: "e" },
  } });
}

it("keeps edited elements associated but excludes a replacement with a reused ID across undo and redo", () => {
  let state = openEditor();
  const snapshot = state.loaded!.model;
  state = editorReducer(state, { type: "command", command: setModelParam("gateway", "handlers", 6) });
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.services.get("gateway")?.values.utilization).toBe(0.5);
  state = editorReducer(state, { type: "command", command: deleteElements(["gateway"]) });
  state = editorReducer(state, { type: "command", command: addBlock(catalog, "service", { x: 260, y: 100 }) });
  const added = Object.keys(state.loaded!.model.blocks).find((id) => !Object.hasOwn(snapshot.blocks, id))!;
  state = editorReducer(state, { type: "command", command: renameElement(added, "gateway") });
  expect(state.loaded!.model.blocks.gateway.params).toEqual({});
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.services.has("gateway")).toBe(false);
  for (let count = 0; count < 3; count++) state = editorReducer(state, { type: "undo" });
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.services.get("gateway")?.values.utilization).toBe(0.5);
  for (let count = 0; count < 3; count++) state = editorReducer(state, { type: "redo" });
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.services.has("gateway")).toBe(false);
});

it("excludes a newly created connection even when the editor reuses its ID and endpoints", () => {
  let state = openEditor();
  const snapshot = state.loaded!.model;
  state = editorReducer(state, { type: "command", command: deleteElements(["client-to-gateway"]) });
  state = editorReducer(state, { type: "command", command: addConnection(catalog, "client", "gateway", "out", "in") });
  expect(state.loaded!.model.connections.some((edge) => edge.id === "client-to-gateway")).toBe(true);
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.connections.has("client-to-gateway")).toBe(false);
  state = editorReducer(editorReducer(state, { type: "undo" }), { type: "undo" });
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.connections.get("client-to-gateway")?.values.amplification).toBe(1.2);
});

it("preserves associations when the same file is reloaded with new object references", () => {
  let state = openEditor();
  const snapshot = state.loaded!.model;
  state = editorReducer(state, { type: "open", loaded: structuredClone(state.loaded!) });
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.services.get("gateway")?.values.utilization).toBe(0.5);
});

it("restores saved element associations when reload discards a local deletion", () => {
  let state = openEditor();
  const snapshot = state.loaded!.model;
  const saved = structuredClone(state.loaded!);
  state = editorReducer(state, { type: "command", command: deleteElements(["gateway"]) });
  state = editorReducer(state, { type: "open", loaded: saved });
  expect(canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)?.services.get("gateway")?.values.utilization).toBe(0.5);
});

it.each(["gateway", "client-to-gateway"])("restores diagram associations when %s is renamed back", (id) => {
  let state = openEditor();
  const snapshot = state.loaded!.model;
  state = editorReducer(state, { type: "command", command: renameElement(id, "temporary") });
  state = editorReducer(state, { type: "command", command: renameElement("temporary", id) });
  const result = canvasResults(summary, snapshot, "baseline", "p0", catalog, state.loaded!.model)!;
  expect(result.services.get("gateway")?.values.utilization).toBe(0.5);
  expect(result.connections.get("client-to-gateway")?.values.amplification).toBe(1.2);
});


it("projects connection totals independently of the target service", () => {
  const run = fixture();
  run.variants[0].points[0].aggregate.connections["gateway-to-middle"] = {
    totals: { sentAttempts: 40, retries: 10, succeeded: 20, failed: 10, timeouts: 10, orphaned: 8,
      inFlightIntegralMs: 600, orphanedIntegralMs: 250, backoffIntegralMs: 100, measurementMs: 2000 },
    timeoutRate: { mean: 0.3, min: 0.2, max: 0.4 },
  };
  const result = canvasResults(run, model, "baseline", "p0", catalog)!;
  expect(result.connections.get("gateway-to-middle")?.values).toMatchObject({
    sentAttemptsPerSecond: 20, timeoutRate: 0.3, meanOrphaned: 0.125, amplification: 2.5,
  });
  // A connection has its own result even if the target has no service totals.
  delete run.variants[0].points[0].aggregate.services.middle;
  expect(canvasResults(run, model, "baseline", "p0", catalog)?.connections.get("gateway-to-middle")?.values.sentAttemptsPerSecond).toBe(20);
  const frame = windowCanvasResults(result, [
    { id: "gateway", windows: [recordedWindow({ busyHandlerTimeMs: 50, offeredAttempts: 9999,
      admittedAttempts: 99, client: { originalArrivals: 1 } })] },
    { id: "middle", windows: [recordedWindow({ busyHandlerTimeMs: 50, offeredAttempts: 9999,
      admittedAttempts: 77, client: { originalArrivals: 1 } })] },
  ] as Parameters<typeof windowCanvasResults>[1], 0, 0, [{ id: "gateway-to-middle", windows: [{
    startMs: 0, durationMs: 100, sentAttempts: 2, retries: 1, succeeded: 0, failed: 0, timeouts: 1,
    orphaned: 1, inFlightIntegralMs: 20, orphanedIntegralMs: 50, backoffIntegralMs: 0,
    latency: { count: 0, sumMs: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
  }] }])!;
  expect(frame.connections.get("gateway-to-middle")?.values).toMatchObject({
    sentAttemptsPerSecond: 20, timeoutRate: 0.5, meanOrphaned: 0.5, amplification: 77,
  });
});
