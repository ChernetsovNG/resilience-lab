import { File } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/apiClient";
import { documentViews, experiment, experimentPath, layout, layoutPath, model, modelPath } from "../test/fixtures";
import type { DocumentDraft, DocumentView } from "../api/apiTypes";
import type { LoadedExperiment } from "./editor";
import { checkDeletionReferences, copyModel, documentsToDelete, exportDocuments, newExperiment, newModel, readImports, runsToDelete, storedExperiments, writeDocuments } from "./fileActions";

const loaded: LoadedExperiment = {
  experimentPath, modelPath, layoutPath, model, layout, experiment,
  saved: { model, layout, experiment }, versions: { model: "v-model", layout: "v-layout", experiment: "v-experiment" },
};
afterEach(() => vi.restoreAllMocks());

describe("workspace file actions", () => {
  it("checks model deletion without reading experiments belonging to another model", async () => {
    vi.spyOn(api, "documents").mockResolvedValue([
      { path: "other/question.experiment.json", kind: "EXPERIMENT", version: "other", modelRef: "other.model.json" },
    ]);
    const read = vi.spyOn(api, "document").mockRejectedValue(new ApiError(404, { code: "DOCUMENT_NOT_FOUND", message: "Missing", diagnostics: [] }));
    await expect(checkDeletionReferences({ path: modelPath, kind: "MODEL", version: "v-model", modelRef: null })).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("ignores a referencing experiment removed between listing and deletion checks", async () => {
    vi.spyOn(api, "documents").mockResolvedValue([
      { path: experimentPath, kind: "EXPERIMENT", version: "v-experiment", modelRef: experiment.modelRef },
    ]);
    vi.spyOn(api, "document").mockRejectedValue(new ApiError(404, { code: "DOCUMENT_NOT_FOUND", message: "Missing", diagnostics: [] }));
    await expect(checkDeletionReferences({ path: modelPath, kind: "MODEL", version: "v-model", modelRef: null })).resolves.toBeUndefined();
  });

  it("protects a layout referenced by an experiment of another model", async () => {
    const path = "other/question.experiment.json";
    vi.spyOn(api, "documents").mockResolvedValue([{ path, kind: "EXPERIMENT", version: "other", modelRef: "other.model.json" }]);
    vi.spyOn(api, "document").mockResolvedValue({ path, kind: "EXPERIMENT", version: "other", content: { experiment: {
      ...experiment, modelRef: "other.model.json", layoutRef: "../retry-storm/retry-storm.layout.json",
    } } });
    await expect(checkDeletionReferences({ path: layoutPath, kind: "LAYOUT", version: "v-layout", modelRef: null })).rejects.toThrow();
  });

  it("propagates experiment read failures other than 404", async () => {
    const error = new ApiError(500, { code: "STORAGE_ERROR", message: "Cannot read", diagnostics: [] });
    vi.spyOn(api, "document").mockRejectedValue(error);
    await expect(storedExperiments([
      { path: experimentPath, kind: "EXPERIMENT", version: "v-experiment", modelRef: experiment.modelRef },
    ])).rejects.toBe(error);
  });

  it("selects current and obsolete runs by the full manifest experiment path, not the shared directory name", async () => {
    const current = { id: "one", experiment: experimentPath, directory: ".results/retry-storm/one", complete: true, sizeBytes: 1024 };
    const other = { ...current, id: "two", experiment: "other/retry-storm.experiment.json", directory: ".results/retry-storm/two" };
    const obsolete = { id: "old", experiment: experimentPath, directory: ".results/retry-storm/old", sizeBytes: 2048 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async url => new Response(JSON.stringify(
      String(url).endsWith("/obsolete") ? [obsolete, { ...obsolete, id: "broken", experiment: null }]
        : String(url).endsWith("/runs") ? [current, other] : [],
    )));
    const plan = await documentsToDelete(loaded, "experiment");
    expect(await runsToDelete(plan)).toEqual([current, obsolete]);
  });

  it.each(["QUEUED", "RUNNING"])("refuses deletion for an experiment with a %s job even before its run has files", async status => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async url => new Response(JSON.stringify(
      String(url).endsWith("/jobs") ? [{ id: "job-active", experiment: experimentPath, runId: "new", status }] : [],
    )));
    await expect(runsToDelete(await documentsToDelete(loaded, "experiment"))).rejects.toThrow(experimentPath);
  });

  it("plans experiments before exclusive referenced layouts and the model, preserving shared and unreferenced files", async () => {
    const secondPath = "questions/second.experiment.json", otherPath = "other/question.experiment.json";
    const exclusive = "questions/exclusive.layout.json", orphan = "retry-storm/orphan.layout.json";
    const views: Record<string, DocumentView> = {
      ...documentViews,
      [secondPath]: { path: secondPath, kind: "EXPERIMENT" as const, version: "second", content: { experiment: {
        ...experiment, modelRef: "../retry-storm/retry-storm.model.json", layoutRef: "./exclusive.layout.json",
      } } },
      [otherPath]: { path: otherPath, kind: "EXPERIMENT" as const, version: "other", content: { experiment: {
        ...experiment, modelRef: "other.model.json", layoutRef: "../retry-storm/retry-storm.layout.json",
      } } },
      [exclusive]: { path: exclusive, kind: "LAYOUT" as const, version: "exclusive", content: { layout } },
      [orphan]: { path: orphan, kind: "LAYOUT" as const, version: "orphan", content: { layout } },
    };
    vi.spyOn(api, "documents").mockResolvedValue(Object.values(views).map(view => ({ ...view, modelRef: view.content.experiment?.modelRef ?? null })));
    vi.spyOn(api, "document").mockImplementation(async path => views[path as keyof typeof views]);
    expect((await documentsToDelete(loaded, "model")).map(({ path, version }) => ({ path, version }))).toEqual([
      { path: secondPath, version: "second" }, { path: experimentPath, version: "v-experiment" },
      { path: exclusive, version: "exclusive" }, { path: modelPath, version: "v-model" },
    ]);
  });

  it("deletes only the current saved experiment, with the version it was opened with", async () => {
    expect((await documentsToDelete(loaded, "experiment")).map(({ path, version }) => ({ path, version }))).toEqual([
      { path: experimentPath, version: "v-experiment" },
    ]);
    expect(await documentsToDelete({ ...loaded, versions: { ...loaded.versions, experiment: null } }, "experiment")).toEqual([]);
  });

  it("creates a baseline question referring to the current model and layout", () => {
    const before = structuredClone(loaded);
    expect(newExperiment(loaded, "capacity")).toEqual([{ path: "retry-storm/capacity.experiment.json", content: { experiment: {
      schemaVersion: 3, modelRef: "retry-storm.model.json", layoutRef: "retry-storm.layout.json",
      execution: { replications: 10, seed: 1, warmup: "10s", measurement: "60s", maxRealTime: "30s" },
      faults: [], grid: [], variants: [{ id: "baseline", label: "Baseline", overrides: {} }],
    } } }]);
    expect(loaded).toEqual(before);
  });

  it("creates the missing layout along with a new experiment for a model-only workspace", () => {
    const drafts = newExperiment({ ...loaded, experiment: { ...experiment, layoutRef: null }, versions: { ...loaded.versions, layout: null } }, "capacity");
    expect(drafts.map(draft => draft.path)).toEqual([layoutPath, "retry-storm/capacity.experiment.json"]);
    expect(drafts[0].content.layout).toEqual(layout);
  });

  it("copies every experiment and its layout while preserving equal filenames in different directories", async () => {
    const secondPath = "questions/retry-storm.experiment.json";
    const second = { ...experiment, modelRef: "../retry-storm/retry-storm.model.json", layoutRef: "separate.layout.json" };
    vi.spyOn(api, "documents").mockResolvedValue([
      { path: experimentPath, kind: "EXPERIMENT", version: "v1", modelRef: "retry-storm.model.json" },
      { path: secondPath, kind: "EXPERIMENT", version: "v2", modelRef: "../retry-storm/retry-storm.model.json" },
    ]);
    vi.spyOn(api, "document").mockImplementation(async path => ({ path, kind: path === secondPath ? "EXPERIMENT" : "LAYOUT", version: "v", content: path === secondPath ? { experiment: second } : { layout } }));
    const drafts = await copyModel(loaded, "copy");
    expect(drafts.map(draft => draft.path)).toEqual([
      "copy/retry-storm/retry-storm.model.json", "copy/retry-storm/retry-storm.layout.json",
      "copy/retry-storm/retry-storm.experiment.json", "copy/questions/retry-storm.experiment.json", "copy/questions/separate.layout.json",
    ]);
    expect(drafts.find(draft => draft.path === "copy/questions/retry-storm.experiment.json")?.content.experiment).toMatchObject({
      modelRef: "../retry-storm/retry-storm.model.json", layoutRef: "separate.layout.json",
    });
    expect(drafts.find(draft => draft.path === "copy/retry-storm/retry-storm.experiment.json")?.content.experiment).toMatchObject({
      modelRef: "retry-storm.model.json", layoutRef: "retry-storm.layout.json",
    });
  });

  it("does not replace another question's stored layout with an unreferenced synthetic layout", async () => {
    const firstPath = "questions/first.experiment.json", secondPath = "questions/second.experiment.json";
    const sharedLayout = "questions/first.layout.json";
    const first = { ...experiment, modelRef: "../retry-storm/retry-storm.model.json", layoutRef: null };
    const second = { ...first, layoutRef: "first.layout.json" };
    const storedLayout = { schemaVersion: 1, positions: { gateway: { x: 99, y: 88 } } };
    vi.spyOn(api, "documents").mockResolvedValue([
      { path: firstPath, kind: "EXPERIMENT", version: "v1", modelRef: first.modelRef },
      { path: secondPath, kind: "EXPERIMENT", version: "v2", modelRef: second.modelRef },
    ]);
    vi.spyOn(api, "document").mockImplementation(async path => ({ path, kind: path === secondPath ? "EXPERIMENT" : "LAYOUT", version: "v",
      content: path === secondPath ? { experiment: second } : { layout: storedLayout } }));
    const drafts = await copyModel({ ...loaded, experimentPath: firstPath, experiment: first,
      layoutPath: sharedLayout, layout: { schemaVersion: 1, positions: {} }, versions: { ...loaded.versions, layout: null } }, "copy");
    expect(drafts.find(draft => draft.path === "copy/questions/first.layout.json")?.content.layout).toEqual(storedLayout);
    expect(drafts.find(draft => draft.path === "copy/questions/first.experiment.json")?.content.experiment?.layoutRef).toBeNull();
  });
  it("builds an empty model with a linked layout and ten default replications", () => {
    const drafts = newModel("my-lab");
    expect(drafts.map(draft => draft.path)).toEqual([
      "my-lab/my-lab.model.json", "my-lab/my-lab.layout.json", "my-lab/my-lab.experiment.json",
    ]);
    expect(drafts[0].content.model?.blocks).toEqual({});
    expect(drafts[0].content.model?.schemaVersion).toBe(6);
    expect(drafts[0].content.model?.connections).toEqual([]);
    expect(drafts[2].content.experiment).toMatchObject({
      modelRef: "my-lab.model.json", layoutRef: "my-lab.layout.json", execution: { replications: 10, warmup: "10s", measurement: "60s" },
    });
  });

  it("copies unsaved documents and rewrites references without changing the source", async () => {
    vi.spyOn(api, "documents").mockResolvedValue([]);
    const edited = { ...loaded, model: { ...model, description: "Unsaved" }, experiment: { ...experiment, modelRef: "../shared/retry-storm.model.json" } };
    const before = structuredClone(edited);
    const drafts = await copyModel(edited, "copy");
    expect(drafts[0]).toEqual({ path: "copy/retry-storm.model.json", content: { model: edited.model } });
    expect(drafts[2].content.experiment).toMatchObject({ modelRef: "retry-storm.model.json", layoutRef: "retry-storm.layout.json" });
    expect(edited).toEqual(before);
  });

  it("reads several files and relocates selected references while preserving the documents", async () => {
    const files = [
      new File([JSON.stringify({ ...experiment, modelRef: "../shared/retry-storm.model.json" })], "retry-storm.experiment.json"),
      new File([JSON.stringify(model)], "retry-storm.model.json"),
      new File([JSON.stringify(layout)], "retry-storm.layout.json"),
    ];
    const drafts = await readImports(files, "imported");
    expect(drafts.find(draft => draft.content.model)?.content.model).toEqual(model);
    expect(drafts.find(draft => draft.content.experiment)?.content.experiment).toMatchObject({
      modelRef: "retry-storm.model.json", layoutRef: "retry-storm.layout.json",
    });
    expect(drafts.every(draft => draft.path.startsWith("imported/"))).toBe(true);
  });

  it("preserves large integer text until ordinary server validation", async () => {
    const source = '{"schemaVersion":3,"modelRef":"model.model.json","execution":{"seed":9007199254740993}}';
    const drafts = await readImports([new File([source], "source.experiment.json")], "imported");
    expect(JSON.stringify(drafts[0].content)).toContain('"seed":9007199254740993');
  });

  it("rejects malformed JSON and unsafe destinations before any write", async () => {
    await expect(readImports([new File(["{"], "broken.model.json")], "safe")).rejects.toThrow();
    for (const directory of ["", "..", "../outside", "/absolute", "a/../b", "a\\b", ".results"]) {
      expect(() => newModel(directory)).toThrow();
    }
  });

  it("cancels an import collision without writing any document", async () => {
    vi.spyOn(api, "documents").mockResolvedValue(Object.values(documentViews));
    const save = vi.spyOn(api, "saveDocument");
    const confirmed = vi.fn(() => false);
    expect(await writeDocuments([{ path: modelPath, content: { model } }], confirmed)).toBe(false);
    expect(confirmed).toHaveBeenCalledWith([modelPath]);
    expect(save).not.toHaveBeenCalled();
  });

  it("waits for an asynchronous import replacement decision and preserves documents on cancel", async () => {
    vi.spyOn(api, "documents").mockResolvedValue(Object.values(documentViews));
    const save = vi.spyOn(api, "saveDocument").mockResolvedValue({ path: modelPath, kind: "MODEL", version: "new-version" });
    let decide!: (accepted: boolean) => void;
    const decision = new Promise<boolean>(resolve => { decide = resolve; });
    const confirmed = vi.fn(() => decision);
    const writing = writeDocuments([{ path: modelPath, content: { model } }], confirmed);
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledWith([modelPath]));
    expect(save).not.toHaveBeenCalled();
    decide(false);
    expect(await writing).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses to replace a copy destination and guards confirmed replacements with If-Match versions", async () => {
    vi.spyOn(api, "documents").mockResolvedValue(Object.values(documentViews));
    const save = vi.spyOn(api, "saveDocument").mockResolvedValue({ path: modelPath, kind: "MODEL", version: "new-version" });
    const drafts = [{ path: modelPath, content: { model } }];
    await expect(writeDocuments(drafts)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(await writeDocuments(drafts, () => true)).toBe(true);
    expect(save).toHaveBeenCalledWith(modelPath, { model }, "v-model");
  });

  it("validates the complete experiment before writing and publishes its reference last", async () => {
    vi.spyOn(api, "documents").mockResolvedValue([]);
    const validate = vi.spyOn(api, "validate").mockResolvedValue({ experiment: "my-lab/my-lab.experiment.json", valid: true, diagnostics: [] });
    const paths: string[] = [];
    vi.spyOn(api, "saveDocument").mockImplementation(async (path) => {
      paths.push(path);
      return { path, kind: "MODEL", version: "new-version" };
    });
    const drafts = newModel("my-lab");
    expect(await writeDocuments([...drafts].reverse())).toBe(true);
    expect(validate).toHaveBeenCalledWith("my-lab/my-lab.experiment.json", [...drafts].reverse());
    expect(paths.at(-1)).toBe("my-lab/my-lab.experiment.json");
  });

  it("shows validation diagnostics and leaves storage untouched for an invalid imported experiment", async () => {
    vi.spyOn(api, "documents").mockResolvedValue([]);
    const diagnostics = [{ severity: "ERROR" as const, code: "PARAM_REQUIRED", message: "Missing rate", document: modelPath, pointer: "/blocks/client/params/rate", path: "client" }];
    vi.spyOn(api, "validate").mockResolvedValue({ experiment: experimentPath, valid: false, diagnostics });
    const save = vi.spyOn(api, "saveDocument");
    await expect(writeDocuments([{ path: experimentPath, content: { experiment } }])).rejects.toMatchObject({ problem: { diagnostics } });
    expect(save).not.toHaveBeenCalled();
  });

  it("stops at a concurrent write conflict without replacing it", async () => {
    vi.spyOn(api, "documents").mockResolvedValue([]);
    vi.spyOn(api, "saveDocument").mockRejectedValue(new ApiError(409, { code: "VERSION_CONFLICT", message: "Changed", diagnostics: [] }));
    const drafts: DocumentDraft[] = [{ path: modelPath, content: { model } }, { path: layoutPath, content: { layout } }];
    await expect(writeDocuments(drafts)).rejects.toMatchObject({ status: 409 });
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    expect(api.saveDocument).toHaveBeenCalledWith(modelPath, { model }, null);
  });

  it("omits an optional layout that has never existed on the server", async () => {
    vi.spyOn(api, "documentText").mockResolvedValue({ text: "canonical", etag: "version" });
    const files = await exportDocuments({ ...loaded, experiment: { ...experiment, layoutRef: null }, versions: { ...loaded.versions, layout: null } });
    expect(files.map(file => file.name)).toEqual(["retry-storm.model.json", "retry-storm.experiment.json"]);
    expect(api.documentText).not.toHaveBeenCalledWith(layoutPath);
  });

  it("exports the server canonical text verbatim instead of serializing the loaded objects", async () => {
    const canonical = '{\n  "schemaVersion": 6\n}\n';
    vi.spyOn(api, "documentText").mockResolvedValue({ text: canonical, etag: "version" });
    const files = await exportDocuments(loaded);
    expect(files.map(file => file.name)).toEqual(["retry-storm.model.json", "retry-storm.layout.json", "retry-storm.experiment.json"]);
    expect(files.every(file => file.text === canonical)).toBe(true);
    expect(api.documentText).toHaveBeenCalledWith(modelPath);
    expect(api.documentText).toHaveBeenCalledWith(layoutPath);
    expect(api.documentText).toHaveBeenCalledWith(experimentPath);
  });
});
