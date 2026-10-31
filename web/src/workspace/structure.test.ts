import { describe, expect, it } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import outputCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { documentDrafts, editorReducer, initialEditorState, setModelParam, type EditorCommand, type EditorDocuments } from "./editor";
import {
  addBlock, addConnection, connectionRule, copySelection, deleteElements, identifierError,
  insertionPosition, moveBlocks, pasteSelection, renameElement,
} from "./structure";

const documents = (): EditorDocuments => structuredClone({ model, layout, experiment });

function roundTrip(before: EditorDocuments, command: EditorCommand) {
  const snapshot = structuredClone(before);
  const loaded = {
    ...before, saved: before,
    experimentPath: "chain.experiment.json", modelPath: "chain.model.json", layoutPath: "chain.layout.json",
    versions: { model: "m", layout: "l", experiment: "e" },
  };
  const opened = editorReducer(initialEditorState, { type: "open", loaded });
  const edited = editorReducer(opened, { type: "command", command });
  expect(edited.past).toHaveLength(1);
  expect(before).toEqual(snapshot);
  const undone = editorReducer(edited, { type: "undo" });
  expect(undone.loaded).toEqual(loaded);
  expect(editorReducer(undone, { type: "redo" }).loaded).toEqual(edited.loaded);
  return edited.loaded!;
}

function scenarioDocuments(): EditorDocuments {
  const before = documents();
  before.model.connections.push({ id: "gateway-to-middle-extra", type: "call", from: "gateway", to: "dependency", params: {} });
  before.model.blocks.gateway.scenario = [
    { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
    { type: "call", connection: "gateway-to-middle" },
    { type: "process" },
    { type: "call", connection: "gateway-to-middle" },
    { type: "call", connection: "gateway-to-middle-extra" },
  ];
  before.model.blocks.middle.scenario = [{ type: "process" }, { type: "call", connection: "middle-to-dependency" }];
  before.model.blocks.dependency.scenario = null;
  return before;
}

describe("structure commands", () => {
  it("renames every repeated scenario call by exact connection id in one undo step", () => {
    const before = scenarioDocuments();
    const after = roundTrip(before, renameElement("gateway-to-middle", "rpc"));
    expect(after.model.blocks.gateway.scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "call", connection: "rpc" },
      { type: "process" },
      { type: "call", connection: "rpc" },
      { type: "call", connection: "gateway-to-middle-extra" },
    ]);
    expect(after.model.blocks.middle).toEqual(before.model.blocks.middle);
    expect(after.model.blocks.dependency.scenario).toBeNull();
    expect(after.model.blocks.client).not.toHaveProperty("scenario");
  });

  it("removes repeated calls to a deleted connection while preserving other steps in one undo step", () => {
    const before = scenarioDocuments();
    const after = roundTrip(before, deleteElements(["gateway-to-middle"]));
    expect(after.model.blocks.gateway.scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "process" },
      { type: "call", connection: "gateway-to-middle-extra" },
    ]);
    expect(after.model.blocks.middle).toEqual(before.model.blocks.middle);
    expect(after.model.connections.some(edge => edge.id === "gateway-to-middle")).toBe(false);
  });

  it("omits a scenario after deleting its last call steps in one undo step", () => {
    const before = documents();
    before.model.blocks.gateway.scenario = [
      { type: "call", connection: "gateway-to-middle" }, { type: "call", connection: "gateway-to-middle" },
    ];
    const after = roundTrip(before, deleteElements(["gateway-to-middle"]));
    expect(after.model.blocks.gateway).not.toHaveProperty("scenario");
  });

  it("removes calls to connections deleted by a block cascade in one undo step", () => {
    const before = scenarioDocuments();
    const after = roundTrip(before, deleteElements(["middle"]));
    expect(after.model.blocks).not.toHaveProperty("middle");
    expect(after.model.blocks.gateway.scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "process" },
      { type: "call", connection: "gateway-to-middle-extra" },
    ]);
    expect(after.model.connections.map(edge => edge.id)).toEqual(["client-to-gateway", "gateway-to-middle-extra"]);
  });

  it("renames a service without changing its scenario connection ids", () => {
    const before = scenarioDocuments();
    const after = roundTrip(before, renameElement("gateway", "entry"));
    expect(after.model.blocks.entry.scenario).toEqual(before.model.blocks.gateway.scenario);
    expect(after.model.connections[1].from).toBe("entry");
  });

  it("pastes repeated and downstream calls using copied connection ids in one undo step", () => {
    const before = scenarioDocuments();
    const fragment = copySelection(before, ["gateway", "middle", "dependency"]);
    const after = roundTrip(before, pasteSelection(fragment));
    expect(after.model.blocks["service-2"].scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "call", connection: "service-2-to-service-3" },
      { type: "process" },
      { type: "call", connection: "service-2-to-service-3" },
      { type: "call", connection: "service-2-to-service-1" },
    ]);
    expect(after.model.blocks["service-3"].scenario).toEqual([{ type: "process" }, { type: "call", connection: "service-3-to-service-1" }]);
    expect(after.model.blocks.gateway).toEqual(before.model.blocks.gateway);
    expect(fragment).toEqual(copySelection(before, ["gateway", "middle", "dependency"]));
  });

  it("drops calls outside a partial copy and rewrites collision-safe ids on every paste", () => {
    const before = scenarioDocuments();
    before.model.blocks["service-1-to-service-2"] = { type: "service", params: {} };
    before.model.blocks.middle.scenario = [{ type: "call", connection: "middle-to-dependency" }];
    const fragment = copySelection(before, ["gateway", "middle"]);
    const first = roundTrip(before, pasteSelection(fragment));
    expect(first.model.blocks["service-1"].scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "call", connection: "service-1-to-service-2-1" },
      { type: "process" },
      { type: "call", connection: "service-1-to-service-2-1" },
    ]);
    expect(first.model.blocks["service-2"]).not.toHaveProperty("scenario");
    const second = roundTrip(first, pasteSelection(fragment));
    expect(second.model.blocks["service-3"].scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "call", connection: "service-3-to-service-4" },
      { type: "process" },
      { type: "call", connection: "service-3-to-service-4" },
    ]);
    expect(second.model.blocks["service-4"]).not.toHaveProperty("scenario");
  });

  it("adds a database leaf and preserves its query parameters when editing and saving", () => {
    const fullCatalog = outputCatalog as Catalog;
    const added = roundTrip(documents(), addBlock(fullCatalog, "database", { x: 20, y: 40 }));
    expect(added.model.blocks["database-1"]).toEqual({ type: "database", params: { maxConnections: 100, queue: 0, processing: { kind: "exponential", mean: "5ms" }, failureRate: "0%" } });
    added.model.blocks["database-1"].params = {
      maxConnections: 3, queue: 12, processing: { kind: "lognormal", mean: "7ms", stdDev: "2ms" }, failureRate: "2%",
    };
    added.model.blocks.router = { type: "router", params: {} };
    expect(connectionRule(fullCatalog, added.model, "gateway", "database-1", "out", "in").type).toBe("call");
    expect(connectionRule(fullCatalog, added.model, "router", "database-1", "out", "in").type).toBe("route");
    expect(connectionRule(fullCatalog, added.model, "database-1", "gateway", "out", "in").error).toBeTruthy();
    const after = roundTrip(added, setModelParam("gateway", "handlers", 8));
    const saved = JSON.parse(JSON.stringify(documentDrafts(after)[0])).content.model;
    expect(saved.blocks["database-1"]).toEqual(added.model.blocks["database-1"]);
  });

  it("renames and deletes group and copied connection fault references including replica suffixes", () => {
    const before = documents();
    before.experiment.faults = ["middle#2", "gateway-to-middle#2", "dependency"].map(target => ({ target, from: "0ms", to: "1s", kind: "slowdown", multiplier: 2 }));
    const renamed = renameElement("middle", "worker")(before);
    expect(renamed.experiment.faults.map(fault => fault.target)).toEqual(["worker#2", "gateway-to-middle#2", "dependency"]);
    const deleted = deleteElements(["worker"])(renamed);
    expect(deleted.experiment.faults.map(fault => fault.target)).toEqual(["dependency"]);
  });

  it("preserves replicas and partial replicaOverrides while editing and saving", () => {
    const before = documents();
    before.model.blocks.middle.params.replicas = 3;
    before.model.blocks.middle.replicaOverrides = { "2": { handlers: 7, processing: { mean: "9ms" } } };
    before.model.connections[1].params.balancing = "leastInFlight";
    const after = roundTrip(before, setModelParam("gateway", "handlers", 8));
    const saved = JSON.parse(JSON.stringify(documentDrafts(after)[0])).content.model;
    expect(saved.blocks.middle).toEqual(before.model.blocks.middle);
    expect(saved.connections).toEqual(before.model.connections);
  });

  it("adds a router and permits calls and nested routes using catalog target types", () => {
    const fullCatalog = outputCatalog as Catalog;
    const after = roundTrip(documents(), addBlock(fullCatalog, "router", { x: 20, y: 40 }));
    expect(after.model.blocks["router-1"]).toEqual({ type: "router", params: { policy: "roundRobin" } });
    after.model.blocks["router-2"] = { type: "router", params: { policy: "random" } };
    expect(connectionRule(fullCatalog, after.model, "gateway", "router-1", "out", "in").type).toBe("call");
    expect(connectionRule(fullCatalog, after.model, "router-1", "dependency", "out", "in").type).toBe("route");
    expect(connectionRule(fullCatalog, after.model, "router-1", "router-2", "out", "in").type).toBe("route");
    expect(connectionRule(fullCatalog, after.model, "client", "router-1", "out", "in").error).toBeTruthy();
  });

  it("opening editing and saving preserves router policy route weights and retry target", () => {
    const before = documents();
    before.model.blocks.router = { type: "router", params: { policy: "leastInFlight" } };
    before.model.connections[1].to = "router";
    before.model.connections[1].params.retryTarget = "other";
    before.model.blocks.gateway.scenario = [
      { type: "process" }, { type: "call", connection: "gateway-to-middle" },
      { type: "process", processing: { kind: "fixed", mean: "3ms" } },
      { type: "call", connection: "gateway-to-middle" },
    ];
    const route = { id: "weighted", type: "route", from: "router", to: "middle", params: { weight: 2.5 } };
    before.model.connections.push(route);
    const after = roundTrip(before, setModelParam("gateway", "handlers", 8));
    const saved = JSON.parse(JSON.stringify(documentDrafts(after)[0])).content.model;
    expect(saved.blocks.router).toEqual(before.model.blocks.router);
    expect(saved.connections).toEqual(before.model.connections);
    expect(saved.blocks.gateway.params.handlers).toBe(8);
    expect(saved.blocks.gateway.scenario).toEqual(before.model.blocks.gateway.scenario);
  });

  it("adds a catalog block with the smallest globally free id and explicit catalog values", () => {
    const before = documents();
    before.model.blocks["service-3"] = { type: "service", params: {} };
    before.model.connections.push({ id: "service-1", type: "call", from: "middle", to: "dependency", params: {} });
    const snapshot = structuredClone(before);
    const after = roundTrip(before, addBlock(catalog, "service", { x: 40, y: 80 }));
    expect(after.model.blocks["service-2"]).toEqual({ type: "service", params: { queue: 0, failureRate: "0%" } });
    expect(after.layout.positions["service-2"]).toEqual({ x: 40, y: 80 });
    expect(before).toEqual(snapshot);
    expect(addBlock(catalog, "call", { x: 0, y: 0 })(before)).toEqual(before);
  });

  it("creates a layout reference in the same undo step as the first block position", () => {
    const before = documents();
    delete before.experiment.layoutRef;
    before.layout.positions = {};
    const after = roundTrip(before, addBlock(catalog, "service", { x: 20, y: 40 }));
    expect(after.experiment.layoutRef).toBe("chain.layout.json");
    expect(after.layout.positions).toEqual({ "service-1": { x: 20, y: 40 } });
  });

  it("chooses connection types and port directions entirely from the catalog", () => {
    const custom = structuredClone(catalog);
    custom.types.find((type) => type.id === "call")!.id = "custom-link";
    expect(connectionRule(custom, model, "gateway", "middle", "out", "in").type).toBe("custom-link");
    expect(connectionRule(custom, model, "client", "gateway", "out", "in").type).toBe("request");
    expect(connectionRule(custom, model, "gateway", "client", "out", "in").error).toBeTruthy();
    expect(connectionRule(custom, model, "gateway", "middle", "in", "out").error).toBeTruthy();
    expect(connectionRule(custom, model, "missing", "middle", "out", "in").error).toBeTruthy();
    custom.types = custom.types.filter((type) => type.id !== "custom-link");
    expect(connectionRule(custom, model, "gateway", "middle", "out", "in").error).toBeTruthy();
  });

  it("creates a connection with a free suffixed id and leaves other documents intact", () => {
    const before = documents();
    const after = roundTrip(before, addConnection(catalog, "gateway", "middle", "out", "in"));
    expect(after.model.connections.at(-1)).toEqual({
      id: "gateway-to-middle-1", type: "call", from: "gateway", to: "middle",
      params: { network: { kind: "fixed", mean: "0ms" }, attempts: 1, backoff: { kind: "none" } },
    });
    expect(after.layout).toBe(before.layout);
    expect(after.experiment).toBe(before.experiment);
    expect(addConnection(catalog, "gateway", "client", "out", "in")(before)).toEqual(before);
  });

  it("deletes blocks, incident and selected connections, positions and exact experiment references atomically", () => {
    const before = documents();
    before.experiment.variants[1].overrides = {
      "middle.handlers": 6, "middle-extra.handlers": 7,
      "gateway-to-middle.timeout": "90ms", "middle-to-dependency.attempts": 1,
      "client-to-gateway.extra": true, "gateway.handlers": 4,
    };
    before.experiment.faults.push({ target: "middle", from: "1ms", to: "2ms", kind: "unavailable" });
    const withGrid = { ...before, experiment: { ...before.experiment, grid: [
      { path: "middle.handlers", values: [1, 2] }, { path: "gateway.handlers", values: [4, 5] },
    ] } };
    const after = roundTrip(withGrid, deleteElements(["middle", "client-to-gateway"]));
    expect(Object.keys(after.model.blocks)).toEqual(["client", "dependency", "gateway"]);
    expect(after.model.connections).toEqual([]);
    expect(after.layout.positions).toEqual({ client: { x: 0, y: 100 }, dependency: { x: 780, y: 100 }, gateway: { x: 260, y: 100 } });
    expect(after.experiment.variants[1].overrides).toEqual({ "middle-extra.handlers": 7, "gateway.handlers": 4 });
    expect(after.experiment.faults).toEqual(before.experiment.faults.slice(0, 1));
    expect((after.experiment as typeof withGrid.experiment).grid).toEqual([{ path: "gateway.handlers", values: [4, 5] }]);
  });

  it("renames a block in place and cascades through endpoints, positions, overrides, faults and grid", () => {
    const before = documents();
    const input = { ...before, experiment: { ...before.experiment,
      variants: [{ id: "v", overrides: { "dependency.processing.mean": "3ms", "dependency-extra.handlers": 2 } }],
      grid: [{ path: "dependency.handlers", values: [1, 2] }],
    } };
    const after = roundTrip(input, renameElement("dependency", "storage"));
    expect(Object.keys(after.model.blocks)).toEqual(["client", "storage", "gateway", "middle"]);
    expect(after.model.connections.at(-1)?.to).toBe("storage");
    expect(after.layout.positions.storage).toEqual({ x: 780, y: 100 });
    expect(after.layout.positions).not.toHaveProperty("dependency");
    expect(after.experiment.faults[0].target).toBe("storage");
    expect(after.experiment.variants[0].overrides).toEqual({ "storage.processing.mean": "3ms", "dependency-extra.handlers": 2 });
    expect((after.experiment as typeof input.experiment).grid[0].path).toBe("storage.handlers");
  });

  it("renames a connection and its nested override and grid paths without renaming its blocks", () => {
    const before = documents();
    const input = { ...before, experiment: { ...before.experiment,
      grid: [{ path: "gateway-to-middle.backoff.base", values: ["1ms", "2ms"] }],
    } };
    const after = roundTrip(input, renameElement("gateway-to-middle", "rpc"));
    expect(after.model.connections[1]).toEqual({ ...before.model.connections[1], id: "rpc" });
    expect(after.model.blocks).toEqual(before.model.blocks);
    expect(after.experiment.variants[1].overrides).toEqual({ "rpc.attempts": 1, "middle-to-dependency.attempts": 1 });
    expect((after.experiment as typeof input.experiment).grid[0].path).toBe("rpc.backoff.base");
  });

  it("validates compiler identifier syntax and global uniqueness, including inherited object names", () => {
    for (const id of ["", "a.b", "a/b", "_hidden", "a b", "a\n", "middle", "gateway-to-middle"]) {
      expect(identifierError(model, id, "gateway")).toBeTruthy();
      expect(renameElement("gateway", id)(documents())).toEqual(documents());
    }
    for (const id of ["gateway", "constructor", "A_b-1", "123"]) expect(identifierError(model, id, "gateway")).toBeNull();
    expect(roundTrip(documents(), renameElement("gateway", "constructor")).model.blocks.constructor).toEqual(model.blocks.gateway);
  });

  it("moves only the named block position without materializing automatic positions", () => {
    const before = documents();
    delete before.layout.positions.middle;
    const after = roundTrip(before, moveBlocks({ gateway: { x: 300, y: 140 } }));
    expect(after.layout.positions).toEqual({ client: { x: 0, y: 100 }, dependency: { x: 780, y: 100 }, gateway: { x: 300, y: 140 } });
    expect(after.model).toBe(before.model);
    expect(after.experiment).toBe(before.experiment);
    expect(moveBlocks({ missing: { x: 1, y: 2 } })(before)).toEqual(before);
  });

  it("copies an immutable fragment with internal connections and pastes new ids and offset positions", () => {
    const before = documents();
    before.model.blocks.gateway = { ...before.model.blocks.gateway, description: "Entry", notes: "Keep this" };
    before.model.connections[1] = { ...before.model.connections[1], description: "RPC", notes: "Keep this too" };
    const fragment = copySelection(before, ["gateway", "middle", "middle-to-dependency"]);
    before.model.blocks.gateway.params.handlers = 99;
    const after = roundTrip(before, pasteSelection(fragment));
    expect(after.model.blocks["service-1"]).toEqual({ ...model.blocks.gateway, description: "Entry", notes: "Keep this" });
    expect(after.model.blocks["service-2"]).toEqual(model.blocks.middle);
    expect(after.model.connections.at(-1)).toEqual({ ...model.connections[1], id: "service-1-to-service-2", from: "service-1", to: "service-2", description: "RPC", notes: "Keep this too" });
    expect(after.model.connections).toHaveLength(4);
    expect(after.layout.positions["service-1"]).toEqual({ x: 300, y: 140 });
    expect(after.layout.positions["service-2"]).toEqual({ x: 560, y: 140 });
    expect(after.experiment).toBe(before.experiment);
  });

  it("copies automatic positions and handles repeated pastes without id collisions", () => {
    const before = documents();
    before.layout.positions = {};
    const fragment = copySelection(before, ["client", "dependency"]);
    const first = pasteSelection(fragment)(before);
    const second = pasteSelection(fragment, 80)(first);
    expect(first.layout.positions["client-1"]).toEqual({ x: 40, y: 140 });
    expect(second.layout.positions["client-2"]).toEqual({ x: 80, y: 180 });
    expect(second.model.blocks["service-2"]).toBeDefined();
    expect(copySelection(before, ["gateway-to-middle"]).blocks).toEqual({});
  });
});


describe("block insertion position", () => {
  it("finds a visible free position when diagonal offsets leave the viewport", () => {
    const position = insertionPosition({ x: 100, y: 100 }, [{ x: 100, y: 100, width: 180, height: 100 }],
      { width: 180, height: 100 }, 20, true, { x: 0, y: 0, width: 300, height: 200 });
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + 180).toBeLessThanOrEqual(300);
    expect(position.y + 100).toBeLessThanOrEqual(200);
    expect(position.y).toBe(0);
  });
  it.each([
    [10, { x: 90, y: 50 }],
    [20, { x: 100, y: 40 }],
    [40, { x: 80, y: 40 }],
  ])("uses the selected %s-unit grid for insertion", (step, expected) => {
    expect(insertionPosition({ x: 91, y: 49 }, [], { width: 180, height: 80 }, step as number, true)).toEqual(expected);
  });

  it("inserts without rounding when snapping is disabled", () => {
    expect(insertionPosition({ x: -91.5, y: 49.25 }, [], { width: 180, height: 80 }, 40, false))
      .toEqual({ x: -91.5, y: 49.25 });
  });

  it.each([
    [10, { x: 300, y: 150 }],
    [20, { x: 300, y: 140 }],
    [40, { x: 320, y: 160 }],
  ])("pastes on the selected %s-unit grid without moving the original", (step, expected) => {
    const before = documents();
    before.layout.positions.gateway = { x: 263, y: 107 };
    const fragment = copySelection(before, ["gateway"]);
    const after = roundTrip(before, pasteSelection(fragment, 40, step as number, true));
    expect(after.layout.positions["service-1"]).toEqual(expected);
    expect(after.layout.positions.gateway).toEqual({ x: 263, y: 107 });
  });

  it("pastes without rounding when snapping is disabled", () => {
    const before = documents();
    before.layout.positions.gateway = { x: -263.5, y: 107.25 };
    const after = roundTrip(before, pasteSelection(copySelection(before, ["gateway"]), 40, 40, false));
    expect(after.layout.positions["service-1"]).toEqual({ x: -223.5, y: 147.25 });
  });

  it.each([
    [{ x: 91, y: 49 }, { x: 100, y: 40 }],
    [{ x: -91, y: -49 }, { x: -100, y: -40 }],
  ])("snaps an unoccupied viewport center %j to the grid", (center, expected) => {
    expect(insertionPosition(center, [], { width: 180, height: 80 })).toEqual(expected);
  });

  it("offsets until the whole new block clears occupied rectangles", () => {
    const occupied = [
      { x: 100, y: 40, width: 180, height: 80 },
      { x: 180, y: 120, width: 180, height: 80 },
    ];
    expect(insertionPosition({ x: 91, y: 49 }, occupied, { width: 180, height: 80 })).toEqual({ x: 260, y: 200 });
    expect(occupied[0]).toEqual({ x: 100, y: 40, width: 180, height: 80 });
  });

  it("avoids a node ahead of the insertion point even when the point itself is free", () => {
    expect(insertionPosition({ x: 100, y: 40 }, [{ x: 240, y: 40, width: 180, height: 80 }], { width: 180, height: 80 }))
      .toEqual({ x: 180, y: 120 });
  });
});


it("reserves the incoming client footprint when it is wider than every existing node", () => {
  expect(insertionPosition({ x: -180, y: 200 }, [{ x: 0, y: 200, width: 176, height: 57.375 }],
    { width: 222.984, height: 57.375 })).toEqual({ x: -100, y: 280 });
});


describe("catalog initial values", () => {
  it.each([
    ["client", { load: { points: [{ time: "0s", rate: "10/s" }] }, deadline: "10s" }],
    ["service", { handlers: 200, queue: 100, processing: { kind: "exponential", mean: "10ms" }, failureRate: "0%", replicas: 1 }],
    ["database", { maxConnections: 100, queue: 0, processing: { kind: "exponential", mean: "5ms" }, failureRate: "0%" }],
    ["router", { policy: "roundRobin" }],
    ["pooler", { maxClientConnections: 1000, poolSize: 20, waitTimeout: "5s", processing: { kind: "fixed", mean: "0.1ms" } }],
  ])("writes valid %s parameters in a single undoable insertion", (type, params) => {
    const after = roundTrip(documents(), addBlock(outputCatalog as Catalog, type as string, { x: 20, y: 40 }));
    expect(after.model.blocks[`${type}-1`]).toEqual({ type, params });
  });

  it("writes call parameters without enabling an optional pool in one undo step", () => {
    const after = roundTrip(documents(), addConnection(outputCatalog as Catalog, "gateway", "middle", "out", "in"));
    expect(after.model.connections.at(-1)?.params).toEqual({
      network: { kind: "fixed", mean: "1ms" }, timeout: "1s", attempts: 1, retryTarget: "any", backoff: { kind: "none" },
    });
  });

  it("keeps inserted object parameters independent of the catalog and subsequent insertions", () => {
    const source = structuredClone(outputCatalog) as Catalog;
    const first = addBlock(source, "database", { x: 0, y: 0 })(documents());
    (first.model.blocks["database-1"].params.processing as Record<string, unknown>).mean = "9ms";
    const second = addBlock(source, "database", { x: 0, y: 0 })(documents());
    expect(second.model.blocks["database-1"].params.processing).toEqual({ kind: "exponential", mean: "5ms" });
    expect(source).toEqual(outputCatalog);
  });
});
