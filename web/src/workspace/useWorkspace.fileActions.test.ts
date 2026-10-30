import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DocumentView } from "../api/apiTypes";
import { catalog, documentViews, experimentPath, modelPath } from "../test/fixtures";
import { copyExperiment, newExperiment } from "./fileActions";
import { useWorkspace } from "./useWorkspace";

function server(failSave = false) {
  const views: Record<string, DocumentView> = structuredClone(documentViews);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    let status = 200;
    if (url === "/api/v1/catalog") body = catalog;
    else if (url === "/api/v1/workspace/documents") body = Object.values(views).map(({ path, kind, version }) => ({ path, kind, version }));
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
      } else if (url.includes("/document/text?")) return new Response("canonical text", { headers: { ETag: "version" } });
      else { body = views[path]; if (body === undefined) { status = 404; body = { code: "DOCUMENT_NOT_FOUND", message: "Missing", diagnostics: [] }; } }
    }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
  return views;
}
afterEach(() => vi.unstubAllGlobals());

it("creates and opens a new experiment and refreshes the picker immediately", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded?.experimentPath).toBe(experimentPath));
  await act(async () => { expect(await result.current.storeDocuments(newExperiment("created"))).toBe(true); });
  expect(result.current.loaded?.experimentPath).toBe("created/created.experiment.json");
  expect(result.current.loaded?.model.blocks.service.type).toBe("service");
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
  const copy = copyExperiment(result.current.loaded!, "copy");
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
