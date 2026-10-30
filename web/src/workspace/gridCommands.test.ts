import { describe, expect, it } from "vitest";
import { experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState } from "./editor";
import { setGridAxes } from "./experimentCommands";

describe("grid commands", () => {
  it("preserves axis/value order, duplicates and other documents; each edit is undoable", () => {
    const documents = { model, layout, experiment };
    const loaded = { ...documents, saved: documents, experimentPath: "test.experiment.json",
      modelPath: "test.model.json", layoutPath: "test.layout.json", versions: { model: "m", layout: "l", experiment: "e" } };
    let state = editorReducer(initialEditorState, { type: "open", loaded });
    const axes = [
      { path: "gateway-to-middle.timeout", values: ["80ms", "40ms", "80ms"] },
      { path: "gateway-to-middle.attempts", values: [3, 1] },
    ];
    for (const grid of [axes.slice(0, 1), axes, [axes[1]], []]) {
      const before = state;
      state = editorReducer(state, { type: "command", command: setGridAxes(grid) });
      expect(state.loaded?.experiment).toEqual({ ...experiment, grid });
      expect(state.loaded?.model).toBe(model);
      expect(state.loaded?.layout).toBe(layout);
      const undone = editorReducer(state, { type: "undo" });
      expect(undone.loaded).toEqual(before.loaded);
      expect(editorReducer(undone, { type: "redo" }).loaded).toEqual(state.loaded);
    }
    expect(experiment.grid).toEqual([]);
  });

  it("rejects more than two axes without recording a change", () => {
    const documents = { model, layout, experiment };
    const axis = { path: "gateway.handlers", values: [1, 2] };
    expect(setGridAxes([axis, axis, axis])(documents)).toBe(documents);
  });

  it("repairs an imported oversized grid without allowing it to grow", () => {
    const grid = ["client.load.sinusoid.phase", "gateway.handlers", "middle.handlers", "dependency.handlers"]
      .map((path) => ({ path, values: [1] }));
    const documents = { model, layout, experiment: { ...experiment, grid } };
    const edited = setGridAxes([{ ...grid[0], values: [2] }, ...grid.slice(1)])(documents);
    expect(edited.experiment.grid?.[0].values).toEqual([2]);
    expect(setGridAxes([...grid, grid[0]])(documents)).toBe(documents);
    const reduced = setGridAxes(grid.slice(1))(documents);
    expect(reduced.experiment.grid).toEqual([
      { path: "gateway.handlers", values: [1] }, { path: "middle.handlers", values: [1] }, { path: "dependency.handlers", values: [1] },
    ]);
    expect(setGridAxes(grid.slice(2))(reduced).experiment.grid).toEqual([
      { path: "middle.handlers", values: [1] }, { path: "dependency.handlers", values: [1] },
    ]);
  });
});
