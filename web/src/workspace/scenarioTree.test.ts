import { expect, it } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import type { EditorDocuments } from "./editor";
import { applyOverrides } from "./params";
import { renameRequestType } from "./requestTypes";
import { copySelection, deleteElements, pasteSelection, renameElement } from "./structure";

function documents(): EditorDocuments {
  const source = structuredClone({ model, experiment, layout });
  delete source.model.blocks.client.params.load;
  source.model.blocks.client.params.classes = [{ id: "checkout", load: { points: [{ time: "0s", rate: "10/s" }] } }];
  source.model.blocks.middle = { type: "cache", params: { keySpaces: [{ id: "product", keys: 100, zipf: 0 }] } };
  source.model.connections = source.model.connections.filter(edge => edge.id !== "middle-to-dependency");
  source.model.connections.push({ id: "gateway-to-dependency", type: "call", from: "gateway", to: "dependency", params: {} });
  source.model.blocks.gateway.title = "Products";
  source.model.blocks.gateway.scenario = [{ type: "parallel", id: "fanout", classes: ["checkout"], branches: [[{
    type: "cacheRead", id: "read", connection: "gateway-to-middle", keySpace: "product", classes: ["checkout"],
    repeat: { count: 20, mode: "parallel" }, onMiss: [{ type: "call", connection: "gateway-to-dependency", classes: ["checkout"] }],
  }]] }];
  source.experiment.variants[0].overrides = { "gateway.steps.read.repeat.count": 2 };
  source.experiment.grid = [{ path: "gateway.steps.read.repeat.count", values: [2, 4] }];
  return source;
}
const read = (source: EditorDocuments, id = "gateway") => source.model.blocks[id].scenario![0].branches![0][0];

it("rebinds nested cache reads and miss calls when renaming a service", () => {
  const before = documents();
  const after = renameElement("gateway", "renamed")(before);
  expect(read(after, "renamed").connection).toBe("renamed-to-middle");
  expect(read(after, "renamed").onMiss![0].connection).toBe("renamed-to-dependency");
  expect(after.model.blocks.renamed.title).toBe("Products");
  expect(read(before).connection).toBe("gateway-to-middle");
});

it("prunes deleted cache reads and their now invalid repeat paths", () => {
  const after = deleteElements(["middle"])(documents());
  expect(after.model.blocks.gateway.scenario).toBeUndefined();
  expect(after.experiment.variants[0].overrides["gateway.steps.read.repeat.count"]).toBeUndefined();
  expect(after.experiment.grid).toEqual([]);
});

it("rebinds nested calls to copied connections and preserves repeat metadata", () => {
  const before = documents();
  const after = pasteSelection(copySelection(before, ["gateway", "middle", "dependency"]))(before);
  const [copiedId] = Object.entries(after.model.blocks).find(([id, block]) => id !== "gateway" && block.title === "Products")!;
  const copied = read(after, copiedId);
  const connection = after.model.connections.find(edge => edge.from === copiedId && after.model.blocks[edge.to].type === "cache")!;
  expect(copied.connection).toBe(connection.id);
  expect(copied.repeat).toEqual({ count: 20, mode: "parallel" });
  expect(copied.onMiss![0].connection).not.toBe("gateway-to-dependency");
});

it("renames request types in branches and miss handlers without changing the source", () => {
  const before = documents();
  const after = renameRequestType("client", 0, "order", catalog)(before);
  expect(after.model.blocks.gateway.scenario![0].classes).toEqual(["order"]);
  expect(read(after).classes).toEqual(["order"]);
  expect(read(after).onMiss![0].classes).toEqual(["order"]);
  expect(read(before).classes).toEqual(["checkout"]);
});

it("projects nested repeat overrides without changing mode or model", () => {
  const before = documents();
  const after = { ...before, model: applyOverrides(before.model, { "gateway.steps.read.repeat.count": 2 }, catalog) };
  expect(read(after).repeat).toEqual({ count: 2, mode: "parallel" });
  expect(read(before).repeat).toEqual({ count: 20, mode: "parallel" });
  expect(after.model.blocks.gateway.params).not.toHaveProperty("steps");
});
