import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DocumentView, RunStorageEntry } from "../api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, layoutPath, modelPath } from "../test/fixtures";
import { copyModel, documentsToDelete, newModel, runsToDelete } from "./fileActions";
import { useWorkspace } from "./useWorkspace";

function server(failSave = false, failDelete?: string, afterDelete?: (path: string, views: Record<string, DocumentView>) => void) {
  const views: Record<string, DocumentView> = structuredClone(documentViews);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    let status = 200;
    if (url === "/api/v1/catalog") body = catalog;
    else if (["/api/v1/runs", "/api/v1/runs/obsolete", "/api/v1/jobs"].includes(url)) body = [];
    else if (url === "/api/v1/workspace/documents") body = Object.values(views).map(({ path, kind, version, content }) => ({ path, kind, version, modelRef: content.experiment?.modelRef ?? null }));
    else if (url.startsWith("/api/v1/workspace/changes")) body = { cursor: "test:0", reset: false, changes: [] };
    else if (url === "/api/v1/validate") body = { experiment: JSON.parse(String(init?.body)).experiment, valid: true, diagnostics: [] };
    else {
      const path = new URL(url, "http://test").searchParams.get("path")!;
      if (init?.method === "PUT") {
        if (failSave) { status = 409; body = { code: "VERSION_CONFLICT", message: "Changed on disk", diagnostics: [] }; }
        else {
          const content = JSON.parse(String(init.body));
          const kind = path.endsWith(".model.json") ? "MODEL" : path.endsWith(".layout.json") ? "LAYOUT" : "EXPERIMENT";
          views[path] = { path, kind, version: `saved-${path}`, content };
          body = { path, kind, version: views[path].version };
        }
      } else if (init?.method === "DELETE") {
        if (views[path] === undefined) {
          status = 404; body = { code: "DOCUMENT_NOT_FOUND", message: "Missing", diagnostics: [] };
        } else if (path === failDelete || new Headers(init.headers).get("If-Match") !== `"${views[path]?.version}"`) {
          status = 409; body = { code: "VERSION_CONFLICT", message: "Changed on disk", diagnostics: [] };
        } else {
          delete views[path];
          afterDelete?.(path, views);
          return new Response(null, { status: 204 });
        }
      } else if (url.includes("/document/text?")) return new Response("canonical text", { headers: { ETag: "version" } });
      else { body = views[path]; if (body === undefined) { status = 404; body = { code: "DOCUMENT_NOT_FOUND", message: "Missing", diagnostics: [] }; } }
    }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
  return views;
}
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

function runStorage(runs: RunStorageEntry[], fail?: string, active = false) {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === "/api/v1/runs" && init?.method !== "DELETE") return Response.json(runs.map(run => ({ ...run, complete: true })));
    if (path === "/api/v1/jobs") return Response.json(active ? [{ id: "active", experiment: experimentPath, runId: "new", status: "QUEUED" }] : []);
    if (path.startsWith("/api/v1/runs?directory=") && init?.method === "DELETE") {
      const directory = new URL(path, "http://test").searchParams.get("directory")!;
      if (directory === fail) return Response.json({ code: "STORAGE_ERROR", message: "Storage failed", diagnostics: [] }, { status: 500 });
      runs.splice(runs.findIndex(run => run.directory === directory), 1);
      return new Response(null, { status: 204 });
    }
    return original(url, init);
  });
}

it("deletes the confirmed runs before documents and preserves another experiment with the same filename", async () => {
  const views = server();
  const own = { id: "one", experiment: experimentPath, directory: ".results/retry-storm/one", sizeBytes: 1024 };
  const other = { ...own, id: "two", experiment: "other/retry-storm.experiment.json", directory: ".results/retry-storm/two" };
  const runs = [own, other];
  runStorage(runs);
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "experiment");
  const runPlan = await runsToDelete(plan);
  await act(async () => { expect(await result.current.removeDocuments(plan, false, runPlan)).toBe(true); });
  expect(runs).toEqual([other]);
  expect(views[experimentPath]).toBeUndefined();
  const deletions = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => decodeURIComponent(String(url)));
  expect(deletions).toEqual([
    "/api/v1/runs?directory=.results/retry-storm/one",
    `/api/v1/workspace/document?path=${experimentPath}`,
  ]);
});

it("reports deleted and remaining runs and keeps every document after a partial run deletion", async () => {
  const views = server();
  const runs = ["one", "two"].map(id => ({ id, experiment: experimentPath, directory: `.results/retry-storm/${id}`, sizeBytes: 1024 }));
  runStorage(runs, ".results/retry-storm/two");
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "experiment");
  const runPlan = await runsToDelete(plan);
  await act(async () => { expect(await result.current.removeDocuments(plan, false, runPlan)).toBe(false); });
  expect(runs.map(run => run.id)).toEqual(["two"]);
  expect(views[experimentPath]).toBeDefined();
  expect(result.current.problem?.message).toContain("Deleted: .results/retry-storm/one.");
  expect(result.current.problem?.message).toContain(`Not deleted: .results/retry-storm/two, ${experimentPath}.`);
});

it("does not begin document deletion when a job appeared after confirmation", async () => {
  const views = server();
  runStorage([], undefined, true);
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "experiment");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(false); });
  expect(views[experimentPath]).toBeDefined();
  expect(result.current.problem?.message).toContain("queued or running");
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
});

it.each(["experiment", "model"] as const)("keeps all runs and documents when the confirmed %s version is stale", async target => {
  const views = server();
  const run = { id: "one", experiment: experimentPath, directory: ".results/retry-storm/one", sizeBytes: 1024 };
  const runs = [run];
  runStorage(runs);
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, target);
  const runPlan = await runsToDelete(plan);
  views[target === "model" ? modelPath : experimentPath].version = "changed-on-disk";
  await act(async () => { expect(await result.current.removeDocuments(plan, false, runPlan)).toBe(false); });
  expect(runs).toEqual([run]);
  expect(Object.keys(views).sort()).toEqual(Object.keys(documentViews).sort());
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
});

it("deletes the only experiment and opens an unsaved default without deleting its model or layout", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded?.experimentPath).toBe(experimentPath));
  const plan = await documentsToDelete(result.current.loaded!, "experiment");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(true); });
  expect(views[experimentPath]).toBeUndefined();
  expect(views[modelPath]).toBeDefined();
  expect(result.current.loaded?.modelPath).toBe(modelPath);
  expect(result.current.loaded?.versions.experiment).toBeNull();
  expect(result.current.loaded?.experiment.execution.replications).toBe(10);
  expect(result.current.loaded?.experiment.variants.map(variant => variant.id)).toEqual(["baseline"]);
  expect(result.current.canUndo).toBe(false);
});

it("opens the most recently visited remaining model after deleting the current one", async () => {
  server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  await act(async () => { await result.current.storeDocuments(newModel("zzz"), undefined, false); });
  await act(async () => { await result.current.storeDocuments(newModel("aaa"), undefined, false); });
  const plan = await documentsToDelete(result.current.loaded!, "model");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(true); });
  expect(result.current.loaded?.modelPath).toBe("zzz/zzz.model.json");
  expect(result.current.models).toEqual([modelPath, "zzz/zzz.model.json"]);
});

it("closes the editor and clears selection and undo when the last model is deleted", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "model");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(true); });
  expect(views).toEqual({});
  expect(result.current.models).toEqual([]);
  expect(result.current.experiments).toEqual([]);
  expect(result.current.selectedModel).toBeNull();
  expect(result.current.loaded).toBeNull();
  expect(result.current.canUndo).toBe(false);
});

it("stops after a partial conflict, identifies removed and remaining files and reconciles the editor", async () => {
  const views = server(false, "retry-storm/retry-storm.layout.json");
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "model");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(false); });
  expect(views[experimentPath]).toBeUndefined();
  expect(views[modelPath]).toBeDefined();
  expect(views["retry-storm/retry-storm.layout.json"]).toBeDefined();
  expect(result.current.problem?.message).toContain(`Deleted: ${experimentPath}.`);
  expect(result.current.problem?.message).toContain("Not deleted: retry-storm/retry-storm.layout.json, retry-storm/retry-storm.model.json.");
  expect(result.current.loaded?.versions.experiment).toBeNull();
  expect(result.current.loading).toBe(false);
});

it("preserves unsaved edits until discarding them is explicitly allowed", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  act(() => result.current.setParam("gateway", "handlers", 7));
  const plan = await documentsToDelete(result.current.loaded!, "model");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(false); });
  expect(views[modelPath]).toBeDefined();
  expect(result.current.dirty).toBe(true);
  await act(async () => { expect(await result.current.removeDocuments(plan, true)).toBe(true); });
  expect(result.current.loaded).toBeNull();
});

it.each(["shared layout", "new dependent experiment"])("requires a fresh confirmation when %s appears after planning", async change => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "model");
  const added = "other/new.experiment.json";
  views[added] = { path: added, kind: "EXPERIMENT", version: "new", content: { experiment: {
    ...experiment, modelRef: change === "shared layout" ? "other.model.json" : "../retry-storm/retry-storm.model.json",
    layoutRef: "../retry-storm/retry-storm.layout.json",
  } } };
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(false); });
  expect(views[experimentPath]).toBeDefined();
  expect(views[layoutPath]).toBeDefined();
  expect(views[modelPath]).toBeDefined();
  expect(views[added]).toBeDefined();
  expect(result.current.problem?.message).toContain("Review the deletion again");
});

it("rechecks surviving references before deleting a layout during the cascade", async () => {
  const added = "other/new.experiment.json";
  const views = server(false, undefined, (path, storage) => {
    if (path === experimentPath) storage[added] = { path: added, kind: "EXPERIMENT", version: "new", content: { experiment: {
      ...experiment, modelRef: "other.model.json", layoutRef: "../retry-storm/retry-storm.layout.json",
    } } };
  });
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  const plan = await documentsToDelete(result.current.loaded!, "model");
  await act(async () => { expect(await result.current.removeDocuments(plan)).toBe(false); });
  expect(views[experimentPath]).toBeUndefined();
  expect(views[layoutPath]).toBeDefined();
  expect(views[modelPath]).toBeDefined();
  expect(views[added]).toBeDefined();
});

it.each(["external deletion", "lost response"])("reconciles deleted documents and clears Undo after %s", async outcome => {
  const views = server(false, undefined, () => { if (outcome === "lost response") throw new Error("Connection lost"); });
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  act(() => result.current.setParam("gateway", "handlers", 7));
  expect(result.current.canUndo).toBe(true);
  const plan = await documentsToDelete(result.current.loaded!, "experiment");
  if (outcome === "external deletion") delete views[experimentPath];
  await act(async () => { expect(await result.current.removeDocuments(plan, true)).toBe(false); });
  expect(result.current.loaded?.versions.experiment).toBeNull();
  expect(result.current.canUndo).toBe(false);
  expect(result.current.problem?.message).toContain(`Deleted: ${experimentPath}.`);
  expect(result.current.problem?.message).toContain("Not deleted: none.");
});

it("creates and opens an empty new model and refreshes the picker immediately", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded?.experimentPath).toBe(experimentPath));
  await act(async () => { expect(await result.current.storeDocuments(newModel("created"), undefined, false)).toBe(true); });
  expect(result.current.loaded?.experimentPath).toBe("created/created.experiment.json");
  expect(result.current.loaded?.model.blocks).toEqual({});
  expect(result.current.models).toContain("created/created.model.json");
  expect(result.current.experiments).toContain("created/created.experiment.json");
  expect(result.current.dirty).toBe(false);
  expect(result.current.loading).toBe(false);
  expect(views["created/created.experiment.json"].content.experiment?.execution.replications).toBe(10);
});

it("save as opens unsaved edits in the copy and leaves the source intact", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  act(() => result.current.setParam("gateway", "handlers", 7));
  const copy = await copyModel(result.current.loaded!, "copy");
  await act(async () => { await result.current.storeDocuments(copy); });
  expect(result.current.loaded?.experimentPath).toBe("copy/retry-storm.experiment.json");
  expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(7);
  expect(views[modelPath].content.model?.blocks.gateway.params.handlers).toBe(4);
  expect(result.current.canUndo).toBe(false);
});

it("does not export when saving fails and preserves unsaved edits", async () => {
  server(true);
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  act(() => result.current.setParam("gateway", "handlers", 7));
  await act(async () => { expect(await result.current.exportFiles(true)).toBeNull(); });
  expect(result.current.conflict).toBe(true);
  expect(result.current.dirty).toBe(true);
  expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(7);
});

it("saves changed documents before exporting their canonical text", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  act(() => result.current.setParam("gateway", "handlers", 7));
  await act(async () => {
    const files = await result.current.exportFiles(true);
    expect(files).toHaveLength(3);
    expect(files?.every(file => file.text === "canonical text")).toBe(true);
  });
  expect(views[modelPath].content.model?.blocks.gateway.params.handlers).toBe(7);
  expect(result.current.dirty).toBe(false);
  expect(result.current.loading).toBe(false);
});
