import { expect, it } from "vitest";
import type { Catalog } from "../api/apiTypes";
import serverCatalog from "../test/catalog.json";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, setModelParam, type EditorDocuments } from "./editor";
import { setVariantParam } from "./experimentCommands";

const catalog = serverCatalog as Catalog;

function documents(): EditorDocuments {
  return { layout, model: { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway,
    params: { ...model.blocks.gateway.params, processing: { kind: "lognormal", mean: "2ms", stdDev: "1ms" } },
  } } }, experiment: { ...experiment,
    grid: [
      { path: "gateway.processing.stdDev", values: ["1ms", "2ms"] },
      { path: "gateway.processing.mean", values: ["2ms", "4ms"] },
    ],
    variants: [
      { id: "baseline", overrides: {} },
      { id: "changed", overrides: { "gateway.processing.stdDev": "3ms", "gateway.processing.mean": "4ms", "middle.handlers": 2 } },
    ],
  } };
}

it.each(["processing.kind", "processing"])("removes newly inapplicable experiment references in one history entry (%s)", path => {
  const before = documents();
  const opened = editorReducer(initialEditorState, { type: "open", loaded: {
    ...before, saved: before, experimentPath: "e.experiment.json", modelPath: "m.model.json", layoutPath: "l.layout.json",
    versions: { model: "m", experiment: "e", layout: "l" },
  } });
  const value = path === "processing.kind" ? "fixed" : { kind: "fixed", mean: "2ms", stdDev: "1ms" };
  const edited = editorReducer(opened, { type: "command", command: setModelParam("gateway", path, value, catalog) });
  expect(edited.loaded!.model.blocks.gateway.params.processing).toEqual({ kind: "fixed", mean: "2ms" });
  expect(edited.loaded!.experiment.grid).toEqual([{ path: "gateway.processing.mean", values: ["2ms", "4ms"] }]);
  expect(edited.loaded!.experiment.variants[1].overrides).toEqual({ "gateway.processing.mean": "4ms", "middle.handlers": 2 });
  expect(edited.loaded!.layout).toBe(before.layout);
  expect(edited.past).toHaveLength(1);
  const undone = editorReducer(edited, { type: "undo" });
  expect(undone.loaded).toEqual(opened.loaded);
  expect(undone.past).toHaveLength(0);
  expect(editorReducer(undone, { type: "redo" }).loaded).toEqual(edited.loaded);
  expect(before.model.blocks.gateway.params.processing).toEqual({ kind: "lognormal", mean: "2ms", stdDev: "1ms" });
  expect(before.experiment.variants[1].overrides).toHaveProperty("gateway.processing.stdDev", "3ms");
});

it("preserves overrides whose own controller keeps the dependent field applicable", () => {
  const before = documents();
  before.experiment.variants.push({ id: "own-kind", overrides: {
    "gateway.processing.kind": "lognormal", "gateway.processing.stdDev": "5ms",
  } });
  const edited = setModelParam("gateway", "processing.kind", "fixed", catalog)(before);
  expect(edited.experiment.variants[1].overrides).not.toHaveProperty("gateway.processing.stdDev");
  expect(edited.experiment.variants[2]).toBe(before.experiment.variants[2]);
});

it("uses catalog applicability for backoff fields and keeps other elements' references", () => {
  const before = { model, layout, experiment: { ...experiment,
    grid: [
      { path: "gateway-to-middle.backoff.multiplier", values: [2, 3] },
      { path: "middle-to-dependency.backoff.multiplier", values: [2, 4] },
    ],
    variants: [{ id: "baseline", overrides: { "gateway-to-middle.backoff.multiplier": 3, "gateway-to-middle.backoff.base": "5ms" } }],
  } };
  const edited = setModelParam("gateway-to-middle", "backoff.kind", "fixed", catalog)(before);
  expect(edited.experiment.grid).toEqual([before.experiment.grid[1]]);
  expect(edited.experiment.variants[0].overrides).toEqual({ "gateway-to-middle.backoff.base": "5ms" });
});

it("does not clean unrelated pre-existing errors or change the experiment for scalar edits", () => {
  const before = documents();
  const edited = setModelParam("gateway", "processing.mean", "8ms", catalog)(before);
  expect(edited.experiment).toBe(before.experiment);
  const fixed = { ...before, model: setModelParam("gateway", "processing.kind", "fixed", catalog)(before).model };
  expect(setModelParam("gateway", "processing.kind", "fixed", catalog)(fixed).experiment).toBe(before.experiment);
});

it("keeps a variant-page controller change scoped to that variant, including shared axes", () => {
  const before = documents();
  const edited = setVariantParam("changed", "gateway", "processing.kind", "fixed", catalog)(before);
  expect(edited.model).toBe(before.model);
  expect(edited.experiment.grid).toBe(before.experiment.grid);
  expect(edited.experiment.variants[0]).toEqual(before.experiment.variants[0]);
  expect(edited.experiment.variants[1].overrides).toEqual({ "gateway.processing": { kind: "fixed", mean: "4ms" }, "middle.handlers": 2 });
});
