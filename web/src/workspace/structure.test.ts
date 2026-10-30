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
  const loaded = {
    ...before, saved: before,
    experimentPath: "chain.experiment.json", modelPath: "chain.model.json", layoutPath: "chain.layout.json",
    versions: { model: "m", layout: "l", experiment: "e" },
  };
  const opened = editorReducer(initialEditorState, { type: "open", loaded });
  const edited = editorReducer(opened, { type: "command", command });
  expect(edited.past).toHaveLength(1);
  const undone = editorReducer(edited, { type: "undo" });
  expect(undone.loaded).toEqual(loaded);
  expect(editorReducer(undone, { type: "redo" }).loaded).toEqual(edited.loaded);
  return edited.loaded!;
}

describe("structure commands", () => {
  it("adds a database leaf and preserves its query parameters when editing and saving", () => {
    const fullCatalog = outputCatalog as Catalog;
    const added = roundTrip(documents(), addBlock(fullCatalog, "database", { x: 20, y: 40 }));
    expect(added.model.blocks["database-1"]).toEqual({ type: "database", params: {} });
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
    before.experiment.faults = ["middle#2", "gateway-to-middle#2", "dependency"].map(target => ({ target, from: "0ms", to: "1s", processingMultiplier: 2 }));
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
    expect(after.model.blocks["router-1"]).toEqual({ type: "router", params: {} });
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

  it("adds a catalog block with the smallest globally free id and no parameter defaults", () => {
    const before = documents();
    before.model.blocks["service-3"] = { type: "service", params: {} };
    before.model.connections.push({ id: "service-1", type: "call", from: "middle", to: "dependency", params: {} });
    const snapshot = structuredClone(before);
    const after = roundTrip(before, addBlock(catalog, "service", { x: 40, y: 80 }));
    expect(after.model.blocks["service-2"]).toEqual({ type: "service", params: {} });
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
      id: "gateway-to-middle-1", type: "call", from: "gateway", to: "middle", params: {},
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
    before.experiment.faults.push({ target: "middle", from: "1ms", to: "2ms" });
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
