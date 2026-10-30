import { File } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/apiClient";
import { documentViews, experiment, experimentPath, layout, layoutPath, model, modelPath } from "../test/fixtures";
import type { DocumentDraft } from "../api/apiTypes";
import type { LoadedExperiment } from "./editor";
import { copyExperiment, exportDocuments, newExperiment, readImports, writeDocuments } from "./fileActions";

const loaded: LoadedExperiment = {
  experimentPath, modelPath, layoutPath, model, layout, experiment,
  saved: { model, layout, experiment }, versions: { model: "v-model", layout: "v-layout", experiment: "v-experiment" },
};
afterEach(() => vi.restoreAllMocks());

describe("workspace file actions", () => {
  it("builds a complete minimal experiment with a linked layout and ten replications", () => {
    const drafts = newExperiment("my-lab");
    expect(drafts.map(draft => draft.path)).toEqual([
      "my-lab/my-lab.model.json", "my-lab/my-lab.layout.json", "my-lab/my-lab.experiment.json",
    ]);
    expect(drafts[0].content.model?.blocks).toMatchObject({ client: { type: "client" }, service: { type: "service" } });
    expect(drafts[0].content.model?.connections).toMatchObject([{ from: "client", to: "service", type: "request" }]);
    expect(drafts[2].content.experiment).toMatchObject({
      modelRef: "my-lab.model.json", layoutRef: "my-lab.layout.json", execution: { replications: 10 },
    });
  });

  it("copies unsaved documents and rewrites references without changing the source", () => {
    const edited = { ...loaded, model: { ...model, description: "Unsaved" }, experiment: { ...experiment, modelRef: "../shared/retry-storm.model.json" } };
    const before = structuredClone(edited);
    const drafts = copyExperiment(edited, "copy");
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
    const source = '{"schemaVersion":1,"modelRef":"model.model.json","execution":{"seed":9007199254740993}}';
    const drafts = await readImports([new File([source], "source.experiment.json")], "imported");
    expect(JSON.stringify(drafts[0].content)).toContain('"seed":9007199254740993');
  });

  it("rejects malformed JSON and unsafe destinations before any write", async () => {
    await expect(readImports([new File(["{"], "broken.model.json")], "safe")).rejects.toThrow();
    for (const directory of ["", "..", "../outside", "/absolute", "a/../b", "a\\b", ".results"]) {
      expect(() => newExperiment(directory)).toThrow();
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
    const drafts = newExperiment("my-lab");
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
    const canonical = '{\n  "schemaVersion": 3\n}\n';
    vi.spyOn(api, "documentText").mockResolvedValue({ text: canonical, etag: "version" });
    const files = await exportDocuments(loaded);
    expect(files.map(file => file.name)).toEqual(["retry-storm.model.json", "retry-storm.layout.json", "retry-storm.experiment.json"]);
    expect(files.every(file => file.text === canonical)).toBe(true);
    expect(api.documentText).toHaveBeenCalledWith(modelPath);
    expect(api.documentText).toHaveBeenCalledWith(layoutPath);
    expect(api.documentText).toHaveBeenCalledWith(experimentPath);
  });
});
