import { expect, it } from "vitest";
import { experiment, layout, model } from "../test/fixtures";
import serverCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { courseData, sumLoadProfiles } from "../experiment/course";
import { applyOverrides, withParam } from "./params";
import { editorReducer, initialEditorState, type EditorDocuments } from "./editor";
import { editRequestTypes, renameRequestType, requestTypeRenameError, switchClientLoad } from "./requestTypes";

const profile = (rate: string) => ({ points: [{ time: "0s", rate }] });
const catalog = serverCatalog as Catalog;
const types = [{ id: "status", load: profile("10/s") }, { id: "checkout", load: profile("20/s") }];
const documents = (): EditorDocuments => ({ model: structuredClone(model), layout, experiment: structuredClone(experiment) });

it("switches representations in one undoable command without losing the old profile", () => {
  const before = documents();
  const opened = editorReducer(initialEditorState, { type: "open", loaded: { ...before, saved: before,
    experimentPath: "e", modelPath: "m", layoutPath: "l", versions: { model: "m", layout: "l", experiment: "e" } } });
  const edited = editorReducer(opened, { type: "command", command: switchClientLoad("client", true, catalog) });
  expect(edited.loaded!.model.blocks.client.params).not.toHaveProperty("load");
  expect(edited.loaded!.model.blocks.client.params.classes).toEqual([{ id: "request-1", load: before.model.blocks.client.params.load }]);
  expect(edited.past).toHaveLength(1);
  expect(editorReducer(edited, { type: "undo" }).loaded).toEqual(opened.loaded);
});

it("sums profiles on the union of knots, including points after the experiment ends", () => {
  const loads = [
    { points: [{ time: "0s", rate: "600/min" }, { time: "30s", rate: "40/s" }] },
    { points: [{ time: "0s", rate: "20/s" }, { time: "10s", rate: "60/s" }, { time: "1min", rate: "10/s" }] },
  ];
  expect(sumLoadProfiles(loads, catalog)).toEqual({ points: [
    { time: "0ms", rate: "30/s" }, { time: "10000ms", rate: "80/s" },
    { time: "30000ms", rate: "80/s" }, { time: "60000ms", rate: "50/s" },
  ] });
  const before = documents();
  before.model = withParam(withParam(before.model, "client", "load", undefined), "client", "classes",
    loads.map((load, index) => ({ id: `type-${index}`, load })));
  const after = switchClientLoad("client", false, catalog)(before);
  expect(after.model.blocks.client.params.classes).toBeUndefined();
  expect(after.model.blocks.client.params.load).toEqual(sumLoadProfiles(loads, catalog));
});

it("renames model references and all client class overrides of the open experiment atomically", () => {
  const before = documents();
  before.model = editRequestTypes("client", types, catalog)(before).model;
  before.model.blocks.gateway.scenario = [{ type: "call", connection: "gateway-to-middle", classes: ["checkout", "status"] }];
  before.model.connections[0] = { ...before.model.connections[0], classes: ["checkout"] };
  before.experiment.variants[0].overrides = { "client.classes": types, "other.classes": [{ id: "checkout", load: profile("5/s") }] };
  const after = renameRequestType("client", 1, "order", catalog)(before);
  expect((after.model.blocks.client.params.classes as typeof types)[1].id).toBe("order");
  expect(after.model.blocks.gateway.scenario![0].classes).toEqual(["order", "status"]);
  expect(after.model.connections[0].classes).toEqual(["order"]);
  expect((after.experiment.variants[0].overrides["other.classes"] as typeof types)[0].id).toBe("order");
  expect(before.model.blocks.gateway.scenario![0].classes).toEqual(["checkout", "status"]);
});

it("keeps dangling references on deletion so compiler diagnostics can explain them", () => {
  const before = documents();
  before.model.blocks.gateway.scenario = [{ type: "call", connection: "gateway-to-middle", classes: ["checkout"] }];
  const after = editRequestTypes("client", [types[0]], catalog)(before);
  expect(after.model.blocks.gateway.scenario).toEqual(before.model.blocks.gateway.scenario);
});

it("replaces a variant's full list and suppresses the inherited opposite representation", () => {
  const before = documents();
  const after = switchClientLoad("client", true, catalog, "baseline")(before);
  expect(after.model).toBe(before.model);
  const overrides = after.experiment.variants[0].overrides;
  expect(overrides).toHaveProperty("client.load", null);
  const effective = applyOverrides(after.model, overrides, catalog);
  expect(effective.blocks.client.params.load).toBeNull();
  expect(effective.blocks.client.params.classes).toEqual([{ id: "request-1", load: before.model.blocks.client.params.load }]);
  const renamed = renameRequestType("client", 0, "status", catalog, "baseline")(after);
  expect(renamed.model).toBe(before.model);
  expect((renamed.experiment.variants[0].overrides["client.classes"] as typeof types)[0].id).toBe("status");
  const single = switchClientLoad("client", false, catalog, "baseline")(after);
  expect(applyOverrides(single.model, single.experiment.variants[0].overrides, catalog).blocks.client.params.classes).toBeUndefined();
});

it("projects request type profiles and their sum without hiding malformed types", () => {
  const draft = editRequestTypes("client", types, catalog)(documents()).model;
  const load = courseData(draft, experiment, catalog).loads[0];
  expect(load.points[0].rate).toBe(30);
  expect(load.types.map(type => [type.id, type.points[0].rate])).toEqual([["status", 10], ["checkout", 20]]);
  expect(sumLoadProfiles([{ points: [{ time: "bad", rate: "10/s" }] }], catalog)).toBeNull();
});

it("preserves a variant's explicitly different load mode when the model switches modes", () => {
  const before = documents();
  before.experiment.variants[0].overrides = { "client.load.points": profile("5/s").points };
  const after = switchClientLoad("client", true, catalog)(before);
  const effective = applyOverrides(after.model, after.experiment.variants[0].overrides, catalog);
  expect(effective.blocks.client.params.classes).toBeNull();
  expect(effective.blocks.client.params.load).toEqual(profile("5/s"));
  expect(after.experiment.variants[0].overrides["client.load.points"]).toEqual(profile("5/s").points);
});

it("suppresses inherited request types when a variant switches to a summed profile", () => {
  const before = editRequestTypes("client", types, catalog)(documents());
  const after = switchClientLoad("client", false, catalog, "baseline")(before);
  expect(after.model).toBe(before.model);
  expect(after.experiment.variants[0].overrides).toMatchObject({ "client.classes": null, "client.load": { points: [{ time: "0ms", rate: "30/s" }] } });
  const effective = applyOverrides(after.model, after.experiment.variants[0].overrides, catalog);
  expect(effective.blocks.client.params.classes).toBeNull();
});

it("renames a shared request type in every client so filters still serve both clients", () => {
  const before = editRequestTypes("client", types, catalog)(documents());
  before.model.blocks.partner = { type: "client", params: { classes: [types[1]], deadline: "1s" } };
  before.model.blocks.other = { type: "client", params: { classes: [{ ...types[0], id: "order" }] } };
  before.model.blocks.gateway.scenario = [{ type: "call", connection: "gateway-to-middle", classes: ["checkout", "order"] }];
  const after = renameRequestType("client", 1, "order", catalog)(before);
  expect((after.model.blocks.partner.params.classes as typeof types)[0].id).toBe("order");
  expect(after.model.blocks.gateway.scenario![0].classes).toEqual(["order"]);
});

it.each(["model", "variant"])("rejects global renames that duplicate IDs in another %s list", target => {
  const before = editRequestTypes("client", [types[1]], catalog)(documents());
  const collision = [types[1], { id: "order", load: profile("5/s") }];
  if (target === "model") before.model.blocks.partner = { type: "client", params: { classes: collision } };
  else before.experiment.variants[0].overrides = { "client.classes": collision };
  expect(requestTypeRenameError(before.model, before.experiment, "client", 0, "order")).not.toBeNull();
  expect(renameRequestType("client", 0, "order", catalog)(before)).toBe(before);
});
