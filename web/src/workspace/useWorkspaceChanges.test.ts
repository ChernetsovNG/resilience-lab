import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentView, WorkspaceChangesView } from "../api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, layoutPath, modelPath } from "../test/fixtures";
import { stubFetch, type StubResponse } from "../test/stubFetch";
import { useWorkspace } from "./useWorkspace";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function emptyChanges(cursor: string): WorkspaceChangesView {
  return { cursor, reset: false, changes: [] };
}

function queuedChanges(...responses: Array<WorkspaceChangesView | Error>) {
  return (since: string | null, call: number): StubResponse => {
    if (call === 0) return { body: emptyChanges("g:0") };
    const response = responses[call - 1];
    if (response instanceof Error) throw response;
    return { body: response ?? emptyChanges(since ?? "g:0") };
  };
}

function harness(options: {
  changes?: (since: string | null, call: number) => StubResponse | Promise<StubResponse>;
  documents?: () => StubResponse | Promise<StubResponse>;
  put?: (path: string) => StubResponse | Promise<StubResponse>;
  beforeDocument?: (path: string) => void | Promise<void>;
} = {}) {
  const views = structuredClone(documentViews);
  let changeCall = 0;
  const fetchMock = stubFetch(async (url, init) => {
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url === "/api/v1/workspace/documents") {
      if (options.documents !== undefined) return options.documents();
      return { body: Object.values(views).map(({ path, kind, version, content }) => ({ path, kind, version, modelRef: content.experiment?.modelRef ?? null })) };
    }
    if (url.startsWith("/api/v1/workspace/changes")) {
      const since = new URL(url, "http://localhost").searchParams.get("since");
      if (options.changes !== undefined) return options.changes(since, changeCall++);
      return { body: emptyChanges(since ?? "g:0") };
    }
    const path = new URL(url, "http://localhost").searchParams.get("path")!;
    if (init?.method === "PUT") {
      if (options.put !== undefined) return options.put(path);
      const kind = path.endsWith(".layout.json") ? "LAYOUT" : path.endsWith(".model.json") ? "MODEL" : "EXPERIMENT";
      return { body: { path, kind, version: `v-${kind.toLowerCase()}-2` } };
    }
    await options.beforeDocument?.(path);
    const document = views[path];
    return document === undefined
      ? { status: 404, body: { code: "DOCUMENT_NOT_FOUND", message: "missing", diagnostics: [] } }
      : { body: document };
  });
  return { fetchMock, views };
}

async function loaded() {
  const hook = renderHook(() => useWorkspace());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current.loaded).not.toBeNull();
  return hook;
}

async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

function modelChange(version: string | null, cursor: string): WorkspaceChangesView {
  return { cursor, reset: false, changes: [{ path: modelPath, kind: "MODEL", version }] };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace change polling", () => {
  it("ignores a missing related experiment and reloads its references after a document update", async () => {
    const path = "questions/related.experiment.json";
    let removed = false;
    const store = harness({
      changes: queuedChanges({ cursor: "g:1", reset: false, changes: [{ path, kind: "EXPERIMENT", version: "related-2" }] }),
      beforeDocument: current => {
        if (current === path && !removed) {
          removed = true;
          delete store.views[path];
        }
      },
    });
    const question: DocumentView = { path, kind: "EXPERIMENT", version: "related-1", content: { experiment: {
      ...experiment, modelRef: "../retry-storm/retry-storm.model.json",
      variants: [{ id: "baseline", overrides: { "gateway.handlers": 8 } }],
    } } };
    store.views[path] = question;
    const { result } = await loaded();
    expect(removed).toBe(true);
    expect(result.current.problem).toBeNull();
    expect(result.current.experimentsUsing("gateway")).toEqual([]);

    store.views[path] = { ...question, version: "related-2" };
    await poll();
    expect(result.current.experimentsUsing("gateway")).toEqual(["related"]);
    expect(result.current.problem).toBeNull();
  });

  it("ignores unrelated documents and reports a changed open model", async () => {
    harness({ changes: queuedChanges(
      { cursor: "g:1", reset: false, changes: [{ path: "other/other.model.json", kind: "MODEL", version: "v-other" }] },
      modelChange("v-external", "g:2"),
    ) });
    const { result } = await loaded();

    await poll();
    expect(result.current.externalChange).toBeNull();
    await poll();
    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("clears only the path that returned to its loaded version", async () => {
    harness({ changes: queuedChanges(
      { cursor: "g:1", reset: false, changes: [
        { path: modelPath, kind: "MODEL", version: "v-external-model" },
        { path: experimentPath, kind: "EXPERIMENT", version: "v-external-experiment" },
      ] },
      { cursor: "g:2", reset: false, changes: [{ path: modelPath, kind: "MODEL", version: "v-model" }] },
    ) });
    const { result } = await loaded();

    await poll();
    expect(result.current.externalChange?.path).toBe(modelPath);
    await poll();
    expect(result.current.externalChange?.path).toBe(experimentPath);
  });

  it("ignores own save entries whether the journal wins or follows the PUT response", async () => {
    const gate = deferred();
    harness({
      changes: queuedChanges(modelChange("v-model-2", "g:1"), modelChange("v-model-2", "g:2")),
      put: async (path) => {
        await gate.promise;
        return { body: { path, kind: "MODEL", version: "v-model-2" } };
      },
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(); });

    await poll();
    expect(result.current.externalChange).toBeNull();
    gate.release();
    await act(async () => { await saving; });
    expect(result.current.externalChange).toBeNull();

    await poll();
    expect(result.current.externalChange).toBeNull();
    expect(result.current.loaded?.versions.model).toBe("v-model-2");
  });

  it("reports an external version buffered behind the own save entry", async () => {
    const gate = deferred();
    harness({
      changes: queuedChanges({ cursor: "g:1", reset: false, changes: [
        { path: modelPath, kind: "MODEL", version: "v-model-2" },
        { path: modelPath, kind: "MODEL", version: "v-model-3" },
      ] }),
      put: async (path) => {
        await gate.promise;
        return { body: { path, kind: "MODEL", version: "v-model-2" } };
      },
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(); });

    await poll();
    expect(result.current.externalChange).toBeNull();
    gate.release();
    await act(async () => { await saving; });
    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("ignores a delayed loaded version retried after saving a newer version", async () => {
    const gate = deferred();
    harness({ changes: async (since, call) => {
      if (call === 0) return { body: emptyChanges("g:0") };
      if (since === "g:0") {
        await gate.promise;
        return { body: modelChange("v-model", "g:1") };
      }
      return { body: modelChange("v-external", "g:2") };
    } });
    const { result } = await loaded();
    await poll();
    act(() => result.current.setParam("gateway", "handlers", 6));
    await act(async () => { expect(await result.current.save()).toBe(true); });

    await act(async () => { gate.release(); });
    await poll();

    expect(result.current.loaded?.versions.model).toBe("v-model-2");
    expect(result.current.dirty).toBe(false);
    expect(result.current.externalChange).toBeNull();
    await poll();
    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("ignores an earlier own save version after another save", async () => {
    let version = 1;
    harness({
      changes: queuedChanges(modelChange("v-model-2", "g:1")),
      put: (path) => ({ body: { path, kind: "MODEL", version: `v-model-${++version}` } }),
    });
    const { result } = await loaded();
    for (const handlers of [6, 7]) {
      act(() => result.current.setParam("gateway", "handlers", handlers));
      await act(async () => { expect(await result.current.save()).toBe(true); });
    }

    await poll();

    expect(result.current.loaded?.versions.model).toBe("v-model-3");
    expect(result.current.externalChange).toBeNull();
  });

  it("remembers a successful file-action write when a later document fails", async () => {
    harness({
      changes: queuedChanges(modelChange("v-model-imported", "g:1")),
      put: (path) => path === modelPath
        ? { body: { path, kind: "MODEL", version: "v-model-imported" } }
        : { status: 500, body: { code: "SAVE_FAILED", message: "write failed", diagnostics: [] } },
    });
    const { result } = await loaded();
    await act(async () => {
      expect(await result.current.storeDocuments([
        { path: modelPath, content: documentViews[modelPath].content },
        { path: experimentPath, content: documentViews[experimentPath].content },
      ], async () => true, false)).toBe(false);
    });
    expect(result.current.problem?.code).toBe("FILE_PARTIAL_WRITE");

    await poll();

    expect(result.current.externalChange).toBeNull();
  });

  it.each([
    ["model", modelPath, "MODEL", "v-model"],
    ["layout", layoutPath, "LAYOUT", "v-layout"],
    ["experiment", experimentPath, "EXPERIMENT", "v-experiment"],
  ] as const)("remembers the loaded %s version across reloads", async (_kind, path, kind, version) => {
    const { views } = harness({ changes: queuedChanges({ cursor: "g:1", reset: false, changes: [{ path, kind, version }] }) });
    const { result } = await loaded();
    views[path].version = "v-reloaded";
    await act(async () => { await result.current.reload(); });

    await poll();

    expect(result.current.externalChange).toBeNull();
  });

  it("does not treat a version known for another path as a known model version", async () => {
    harness({ changes: queuedChanges(modelChange("v-layout", "g:1")) });
    const { result } = await loaded();

    await poll();

    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("does not reuse known versions from an earlier workspace session", async () => {
    const { views } = harness({ changes: (since) => ({ body: since === null ? emptyChanges("g:0") : modelChange("v-model", "g:1") }) });
    const first = await loaded();
    views[modelPath].version = "v-reloaded";
    await act(async () => { await first.result.current.reload(); });
    first.unmount();
    const { result } = await loaded();

    await poll();

    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("reconciles open versions and refreshes experiments after reset", async () => {
    const otherPath = "retry-storm/other.experiment.json";
    const other: DocumentView = { path: otherPath, kind: "EXPERIMENT", version: "v-other", content: { experiment } };
    const { views } = harness({ changes: queuedChanges({ cursor: "h:0", reset: true, changes: [] }) });
    const { result } = await loaded();
    views[modelPath].version = "v-external";
    views[otherPath] = other;

    await poll();

    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
    expect(result.current.experiments).toEqual([otherPath, experimentPath]);
  });

  it("detects a missing open document after reset", async () => {
    const { views } = harness({ changes: queuedChanges({ cursor: "h:0", reset: true, changes: [] }) });
    const { result } = await loaded();
    delete views[modelPath];

    await poll();

    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: true });
  });

  it("refreshes experiments after ordinary creation and deletion entries", async () => {
    const otherPath = "retry-storm/other.experiment.json";
    const { views } = harness({ changes: queuedChanges(
      { cursor: "g:1", reset: false, changes: [{ path: otherPath, kind: "EXPERIMENT", version: "v-other" }] },
      { cursor: "g:2", reset: false, changes: [{ path: otherPath, kind: "EXPERIMENT", version: null }] },
    ) });
    const { result } = await loaded();
    views[otherPath] = { path: otherPath, kind: "EXPERIMENT", version: "v-other", content: { experiment } };
    await poll();
    expect(result.current.experiments).toEqual([otherPath, experimentPath]);

    delete views[otherPath];
    await poll();
    expect(result.current.experiments).toEqual([experimentPath]);
  });

  it("stays silent after a failed poll and succeeds on the next attempt", async () => {
    harness({ changes: queuedChanges(new Error("offline"), modelChange("v-external", "g:1")) });
    const { result } = await loaded();

    await poll();
    expect(result.current.externalChange).toBeNull();
    expect(result.current.problem).toBeNull();
    await poll();
    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("shows deletion and does not reread the missing document", async () => {
    const { fetchMock } = harness({ changes: queuedChanges(modelChange(null, "g:1")) });
    const { result } = await loaded();
    await poll();
    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: true });
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/workspace/document?")).length;

    await act(async () => { await result.current.reload(); });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/workspace/document?")).length).toBe(reads);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
  });

  it("still saves after an external notice and preserves the existing 409 conflict", async () => {
    const { fetchMock } = harness({
      changes: queuedChanges(modelChange("v-external", "g:1")),
      put: () => ({ status: 409, body: { code: "VERSION_CONFLICT", message: "stale", diagnostics: [] } }),
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    await poll();
    expect(result.current.conflict).toBe(false);

    await act(async () => { await result.current.save(); });

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(result.current.conflict).toBe(true);
    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("recovers an externally created generated layout on reload", async () => {
    const { views } = harness({ changes: queuedChanges({
      cursor: "g:1", reset: false,
      changes: [{ path: layoutPath, kind: "LAYOUT", version: "v-layout-new" }],
    }) });
    delete views[layoutPath];
    views[experimentPath].content.experiment!.layoutRef = null;
    const { result } = await loaded();
    views[layoutPath] = {
      path: layoutPath, kind: "LAYOUT", version: "v-layout-new",
      content: { layout: { schemaVersion: 2, sizes: {}, edges: {}, positions: { gateway: { x: 99, y: 100 } } } },
    };
    await poll();
    expect(result.current.externalChange).toEqual({ path: layoutPath, deleted: false });

    await act(async () => { await result.current.reload(); });

    expect(result.current.loaded?.layout.positions.gateway).toEqual({ x: 99, y: 100 });
    expect(result.current.loaded?.versions.layout).toBe("v-layout-new");
    expect(result.current.loaded?.experiment.layoutRef).toBeNull();
    expect(result.current.externalChange).toBeNull();
  });

  it("ignores a known old version buffered until the PUT response", async () => {
    const gate = deferred();
    harness({
      changes: queuedChanges({ cursor: "g:1", reset: false, changes: [
        { path: modelPath, kind: "MODEL", version: "v-model-2" },
        { path: modelPath, kind: "MODEL", version: "v-model" },
      ] }),
      put: async (path) => {
        await gate.promise;
        return { body: { path, kind: "MODEL", version: "v-model-2" } };
      },
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(); });

    await poll();
    expect(result.current.externalChange).toBeNull();
    gate.release();
    await act(async () => { await saving; });
    expect(result.current.externalChange).toBeNull();
  });

  it("defers deletion of a newly created layout until the PUT response", async () => {
    const gate = deferred();
    const { views } = harness({
      changes: queuedChanges({ cursor: "g:1", reset: false, changes: [
        { path: layoutPath, kind: "LAYOUT", version: "v-layout-2" },
        { path: layoutPath, kind: "LAYOUT", version: null },
      ] }),
      put: async (path) => {
        if (path === layoutPath) await gate.promise;
        return { body: { path, kind: path === layoutPath ? "LAYOUT" : "EXPERIMENT", version: path === layoutPath ? "v-layout-2" : "v-experiment-2" } };
      },
    });
    delete views[layoutPath];
    views[experimentPath].content.experiment!.layoutRef = null;
    const { result } = await loaded();
    act(() => result.current.execute((documents) => ({
      ...documents,
      layout: { ...documents.layout, positions: { gateway: { x: 10, y: 20 } } },
    })));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(); });

    await poll();
    expect(result.current.externalChange).toBeNull();
    gate.release();
    await act(async () => { await saving; });
    expect(result.current.externalChange).toEqual({ path: layoutPath, deleted: true });
  });

  it("retries a journal response that arrives while reload is reading", async () => {
    const readGate = deferred();
    const readStarted = deferred();
    let pauseRead = false;
    harness({
      changes: (since, call) => {
        if (call === 0) return { body: emptyChanges("g:0") };
        return { body: since === "g:0" ? modelChange("v-external", "g:1") : emptyChanges("g:1") };
      },
      beforeDocument: async (path) => {
        if (pauseRead && path === modelPath) {
          pauseRead = false;
          readStarted.release();
          await readGate.promise;
        }
      },
    });
    const { result } = await loaded();
    pauseRead = true;
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reload(); });
    await act(async () => { await readStarted.promise; });

    await poll();
    readGate.release();
    await act(async () => { await reloading; });
    await poll();

    expect(result.current.externalChange).toEqual({ path: modelPath, deleted: false });
  });

  it("discards a reset list captured before the PUT response", async () => {
    const listGate = deferred();
    const listStarted = deferred();
    let pauseList = false;
    const { views } = harness({
      changes: (since, call) => {
        if (call === 0) return { body: emptyChanges("g:0") };
        return { body: since === "g:0" ? { cursor: "h:0", reset: true, changes: [] } : emptyChanges("h:0") };
      },
      documents: async () => {
        const body = Object.values(views).map(({ path, kind, version, content }) => ({ path, kind, version, modelRef: content.experiment?.modelRef ?? null }));
        if (pauseList) {
          pauseList = false;
          listStarted.release();
          await listGate.promise;
        }
        return { body };
      },
      put: (path) => {
        views[path].version = "v-model-2";
        return { body: { path, kind: "MODEL", version: "v-model-2" } };
      },
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    pauseList = true;
    let polling!: Promise<unknown>;
    await act(async () => {
      polling = vi.advanceTimersByTimeAsync(1000);
      await listStarted.promise;
    });
    await act(async () => { await result.current.save(); });
    await act(async () => {
      listGate.release();
      await polling;
    });
    await poll();

    expect(result.current.externalChange).toBeNull();
  });
});
