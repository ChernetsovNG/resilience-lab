import { describe, expect, it } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import outputCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { documentDrafts, editorReducer, initialEditorState, setModelParam, type EditorCommand, type EditorDocuments } from "./editor";
import {
  addBlock, addConnection, connectionRule, copySelection, deleteElements, identifierError,
  insertionPosition, moveBlocks, pasteSelection, renameElement, resizeBlock, resetBlockSize, setEdgePoints, resetEdgePoints,
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

  it("renames a service and its automatic scenario connections in one undo step", () => {
    const before = scenarioDocuments();
    const after = roundTrip(before, renameElement("gateway", "entry"));
    expect(after.model.blocks.entry.scenario).toEqual([
      { type: "process", processing: { kind: "fixed", mean: "3ms" }, failureRate: "1%" },
      { type: "call", connection: "entry-to-middle" },
      { type: "process" },
      { type: "call", connection: "entry-to-middle" },
      { type: "call", connection: "gateway-to-middle-extra" },
    ]);
    expect(after.model.connections[1].from).toBe("entry");
  });

  it.each([
    ["gateway", "catalog", "catalog-to-middle", "catalog-to-middle-2"],
    ["middle", "pricing", "gateway-to-pricing", "gateway-to-pricing-2"],
  ])("renames automatic connections at endpoint %s with every reference and keeps manual ids", (id, next, automatic, numbered) => {
    const before = scenarioDocuments();
    before.model.connections.push(
      { ...before.model.connections[1], id: "gateway-to-middle-2" },
      { ...before.model.connections[1], id: "gateway-to-middle-custom" },
    );
    before.model.blocks.gateway.scenario!.push(
      { type: "call", connection: "gateway-to-middle-2" },
      { type: "call", connection: "gateway-to-middle-custom" },
    );
    before.experiment.variants[1].overrides = {
      "gateway-to-middle.timeout": "90ms", "gateway-to-middle-2.attempts": 2, "gateway-to-middle-custom.timeout": "30ms",
    };
    before.experiment.grid = [{ path: "gateway-to-middle-2.timeout", values: ["60ms", "90ms"] }];
    before.experiment.faults = ["gateway-to-middle", "gateway-to-middle-2#2", "gateway-to-middle-custom"].map(target =>
      ({ target, from: "0ms", to: "1s", kind: "slowdown", multiplier: 2 }));
    const after = roundTrip(before, renameElement(id, next));
    const calls = after.model.blocks[id === "gateway" ? next : "gateway"].scenario!.filter(step => step.type === "call");
    expect(calls.map(step => step.connection)).toEqual([automatic, automatic, "gateway-to-middle-extra", numbered, "gateway-to-middle-custom"]);
    expect(after.model.connections.map(edge => edge.id)).toContain(numbered);
    expect(after.experiment.variants[1].overrides).toEqual({
      [`${automatic}.timeout`]: "90ms", [`${numbered}.attempts`]: 2, "gateway-to-middle-custom.timeout": "30ms",
    });
    expect(after.experiment.grid).toEqual([{ path: `${numbered}.timeout`, values: ["60ms", "90ms"] }]);
    expect(after.experiment.faults.map(fault => fault.target)).toEqual([automatic, `${numbered}#2`, "gateway-to-middle-custom"]);
    expect(after.model.connections.find(edge => edge.id === "gateway-to-middle-custom")).toMatchObject({
      from: id === "gateway" ? next : "gateway", to: id === "middle" ? next : "middle",
    });
    expect(after.model.blocks.dependency).toEqual(before.model.blocks.dependency);
  });

  it("avoids block and manual connection collisions and stays automatic across subsequent renames", () => {
    const before = scenarioDocuments();
    before.model.blocks["catalog-to-middle"] = { type: "service", params: {} };
    before.model.connections.push({ id: "catalog-to-middle-1", type: "call", from: "middle", to: "dependency", params: {} });
    const first = roundTrip(before, renameElement("gateway", "catalog"));
    expect(first.model.connections[1].id).toBe("catalog-to-middle-2");
    expect(first.model.blocks.catalog.scenario![1].connection).toBe("catalog-to-middle-2");
    const second = roundTrip(first, renameElement("middle", "pricing"));
    expect(second.model.connections[1]).toMatchObject({ id: "catalog-to-pricing-2", from: "catalog", to: "pricing" });
    expect(second.model.blocks.catalog.scenario![1].connection).toBe("catalog-to-pricing-2");
    expect(second.model.connections.at(-1)).toMatchObject({ id: "catalog-to-middle-1", from: "pricing", to: "dependency" });
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
    expect(renamed.experiment.faults.map(fault => fault.target)).toEqual(["worker#2", "gateway-to-worker#2", "dependency"]);
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
  const anchor = { x: 100, y: 100, width: 180, height: 80 };
  const bounds = { x: 0, y: 0, width: 800, height: 600 };

  it("places a new block to the right of the selected node with a gap", () => {
    expect(insertionPosition({ x: 0, y: 0 }, [anchor], { width: 180, height: 80 }, 20, true, bounds, anchor))
      .toEqual({ x: 320, y: 100 });
  });

  it("places a new block below the selected node when its right side is occupied", () => {
    expect(insertionPosition({ x: 0, y: 0 }, [anchor, { ...anchor, x: 320 }],
      { width: 180, height: 80 }, 20, true, bounds, anchor)).toEqual({ x: 100, y: 220 });
  });

  it("prefers a visible position below an anchor at the right edge", () => {
    const edge = { ...anchor, x: 600 };
    expect(insertionPosition({ x: 300, y: 200 }, [edge], { width: 180, height: 80 }, 20, true, bounds, edge))
      .toEqual({ x: 600, y: 220 });
  });

  it("keeps searching right or below when both preferred anchor positions are occupied", () => {
    const selected = { ...anchor, x: 400, y: 200 };
    const occupied = [selected, { ...selected, x: 620 }, { ...selected, y: 320 }];
    const position = insertionPosition({ x: 0, y: 0 }, occupied, { width: 180, height: 80 },
      20, true, { x: 0, y: 0, width: 1000, height: 800 }, selected);
    expect(position.x >= 620 || position.y >= 320).toBe(true);
  });

  it("uses remaining visible space when an anchor has no room right or below", () => {
    const selected = { x: 600, y: 500, width: 180, height: 80 };
    expect(insertionPosition({ x: 320, y: 260 }, [selected], { width: 180, height: 80 },
      20, true, bounds, selected)).toEqual({ x: 320, y: 260 });
  });

  it("finds the nearest visible free space when no node is selected", () => {
    expect(insertionPosition({ x: 100, y: 100 }, [anchor], { width: 180, height: 80 },
      20, true, { x: -200, y: -200, width: 1000, height: 1000 })).toEqual({ x: 100, y: -20 });
  });

  it("leaves a gap even when the requested position only touches an existing node", () => {
    const position = insertionPosition({ x: 280, y: 100 }, [anchor], { width: 180, height: 80 });
    expect(position.x >= 320 || position.y >= 220 || position.x + 180 <= 60 || position.y + 80 <= 60).toBe(true);
  });

  it("keeps the measured anchor gap without snapping", () => {
    const measured = { x: 100.5, y: 100.25, width: 222.984, height: 81.375 };
    const position = insertionPosition({ x: 0, y: 0 }, [measured], { width: 192, height: 110 }, 40, false, bounds, measured);
    expect(position.x).toBeCloseTo(363.484, 10);
    expect(position.y).toBe(100.25);
  });

  it("finds a visible free position when diagonal offsets leave the viewport", () => {
    const position = insertionPosition({ x: 100, y: 100 }, [{ x: 100, y: 140, width: 180, height: 100 }],
      { width: 180, height: 100 }, 20, true, { x: 0, y: 0, width: 300, height: 240 });
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + 180).toBeLessThanOrEqual(300);
    expect(position.y + 100).toBeLessThanOrEqual(240);
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
    const position = insertionPosition({ x: 91, y: 49 }, occupied, { width: 180, height: 80 });
    for (const node of occupied) {
      expect(position.x >= node.x + node.width + 40 || position.y >= node.y + node.height + 40).toBe(true);
    }
    expect(occupied[0]).toEqual({ x: 100, y: 40, width: 180, height: 80 });
  });

  it("avoids a node ahead of the insertion point even when the point itself is free", () => {
    expect(insertionPosition({ x: 100, y: 40 }, [{ x: 240, y: 40, width: 180, height: 80 }], { width: 180, height: 80 }))
      .toEqual({ x: 220, y: 160 });
  });
});


it("reserves the incoming client footprint when it is wider than every existing node", () => {
  expect(insertionPosition({ x: -180, y: 200 }, [{ x: 0, y: 200, width: 176, height: 57.375 }],
    { width: 222.984, height: 57.375 })).toEqual({ x: -60, y: 320 });
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

it("retains request classes and structural filters when renaming and copying graph elements", () => {
  const before = documents();
  before.model.blocks.client.params = { deadline: "2s", classes: [
    { id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }] } },
  ] };
  before.model.blocks.router = { type: "router", params: { policy: "roundRobin" } };
  before.model.blocks.gateway.scenario = [{ type: "call", connection: "gateway-to-middle" }];
  Object.assign(before.model.blocks.gateway.scenario[0], { classes: ["checkout"] });
  before.model.connections[1].to = "router";
  before.model.connections.push({ id: "checkout-route", type: "route", from: "router", to: "middle", params: {} });
  Object.assign(before.model.connections.at(-1)!, { classes: ["checkout"] });
  const renamed = roundTrip(before, renameElement("gateway-to-middle", "rpc"));
  expect(renamed.model.blocks.gateway.scenario).toEqual([{ type: "call", connection: "rpc", classes: ["checkout"] }]);
  const copied = roundTrip(renamed, pasteSelection(copySelection(renamed, ["gateway", "router", "middle"])));
  expect(copied.model.blocks["service-1"].scenario).toEqual([
    { type: "call", connection: "service-1-to-router-1", classes: ["checkout"] },
  ]);
  expect(copied.model.connections.at(-1)).toMatchObject({ id: "router-1-to-service-2", classes: ["checkout"] });
  expect(copied.model.blocks.client).toEqual(before.model.blocks.client);
});


describe("authored layout", () => {
  function manual() {
    const before = documents();
    before.layout.sizes = { gateway: { width: 300, height: 280 }, middle: { width: 240, height: 250 } };
    before.layout.edges = { "gateway-to-middle": { points: [{ x: 420, y: 20 }] }, "middle-to-dependency": { points: [{ x: 700, y: 20 }] } };
    return before;
  }
  it("commits a left resize position and size in one Undo/Redo step, then resets to auto", () => {
    const before = manual();
    const after = roundTrip(before, resizeBlock("gateway", { x: -40, y: 60 }, { width: 340, height: 300 }));
    expect(after.layout.positions.gateway).toEqual({ x: -40, y: 60 });
    expect(after.layout.sizes.gateway).toEqual({ width: 340, height: 300 });
    expect(after.layout.edges).toEqual(before.layout.edges);
    const automatic = roundTrip(after, resetBlockSize("gateway"));
    expect(automatic.layout.sizes).not.toHaveProperty("gateway");
    expect(automatic.layout.positions).toEqual(after.layout.positions);
  });
  it("renames sizes and automatically renamed incident paths atomically", () => {
    const after = roundTrip(manual(), renameElement("gateway", "entry"));
    expect(after.layout.sizes).toEqual({ entry: { width: 300, height: 280 }, middle: { width: 240, height: 250 } });
    expect(after.layout.edges).toEqual({ "entry-to-middle": { points: [{ x: 420, y: 20 }] }, "middle-to-dependency": { points: [{ x: 700, y: 20 }] } });
    const renamed = roundTrip(after, renameElement("entry-to-middle", "rpc"));
    expect(renamed.layout.edges.rpc).toEqual(after.layout.edges["entry-to-middle"]);
    expect(renamed.layout.edges).not.toHaveProperty("entry-to-middle");
  });
  it("deletes sizes and incident paths while retaining unrelated layout", () => {
    const after = roundTrip(manual(), deleteElements(["gateway"]));
    expect(after.layout.sizes).toEqual({ middle: { width: 240, height: 250 } });
    expect(after.layout.edges).toEqual({ "middle-to-dependency": { points: [{ x: 700, y: 20 }] } });
    expect(roundTrip(manual(), deleteElements(["gateway-to-middle"])).layout.edges).not.toHaveProperty("gateway-to-middle");
  });
  it("copies authored sizes for selected blocks but leaves copied connections automatic", () => {
    const before = manual();
    const after = roundTrip(before, pasteSelection(copySelection(before, ["gateway", "middle"])));
    const copied = Object.keys(after.model.blocks).filter(id => !Object.hasOwn(before.model.blocks, id));
    expect(copied.map(id => after.layout.sizes[id])).toEqual([{ width: 300, height: 280 }, { width: 240, height: 250 }]);
    expect(after.layout.edges).toEqual(before.layout.edges);
  });
});


it("renames authored sizes and incident paths over stale destination layout ids", () => {
  const before = documents();
  before.layout.sizes = { gateway: { width: 320, height: 280 }, entry: { width: 1, height: 1 } };
  before.layout.edges = { "gateway-to-middle": { points: [{ x: 400, y: 10 }] }, "entry-to-middle": { points: [{ x: 1, y: 1 }] } };
  const renamed = roundTrip(before, renameElement("gateway", "entry"));
  expect(renamed.layout.sizes.entry).toEqual({ width: 320, height: 280 });
  expect(renamed.layout.edges["entry-to-middle"]).toEqual({ points: [{ x: 400, y: 10 }] });
  renamed.layout.edges.rpc = { points: [{ x: 0, y: 0 }] };
  expect(roundTrip(renamed, renameElement("entry-to-middle", "rpc")).layout.edges.rpc).toEqual({ points: [{ x: 400, y: 10 }] });
});


describe("edge layout commands", () => {
  it("sets and resets points as single undoable operations without changing the model", () => {
    const before = documents();
    const points = [{ x: 400, y: -200 }, { x: 700, y: -200 }];
    const after = roundTrip(before, setEdgePoints("gateway-to-middle", points));
    expect(after.layout.edges["gateway-to-middle"]).toEqual({ points });
    expect(after.model).toEqual(before.model);
    const reset = roundTrip(after, resetEdgePoints("gateway-to-middle"));
    expect(reset.layout.edges).not.toHaveProperty("gateway-to-middle");
    expect(resetEdgePoints("missing")(before)).toBe(before);
    expect(setEdgePoints("missing", points)(before)).toBe(before);
    expect(setEdgePoints("gateway-to-middle", points)(after)).toBe(after);
  });

  it("accepts at most 50 finite points, rejecting the whole invalid edit", () => {
    const before = documents();
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: -i }));
    expect(setEdgePoints("gateway-to-middle", points)(before).layout.edges["gateway-to-middle"].points).toHaveLength(50);
    expect(setEdgePoints("gateway-to-middle", [...points, { x: 51, y: 0 }])(before)).toBe(before);
    expect(setEdgePoints("gateway-to-middle", [{ x: Infinity, y: 0 }])(before)).toBe(before);
    expect(setEdgePoints("gateway-to-middle", [])(before)).toBe(before);
  });
});
