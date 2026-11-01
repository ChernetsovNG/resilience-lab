import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentContent, DocumentView } from "../api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, layout, layoutPath, model, modelPath } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { useWorkspace } from "./useWorkspace";

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguage("en");
  localStorage.clear();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function stubWorkspace(options: { putStatus?: number; conflictPath?: string; putGate?: Promise<void>; beforeDocument?: (path: string) => Promise<void>; documents?: Record<string, DocumentView> } = {}) {
  const views = { ...documentViews, ...options.documents };
  return stubFetch(async (url, init) => {
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url === "/api/v1/workspace/documents") {
      return { body: Object.values(documentViews).map(({ path, kind, version, content }) => ({ path, kind, version, modelRef: content.experiment?.modelRef ?? null })) };
    }
    const path = decodeURIComponent(url.split("path=")[1] ?? "");
    if (init?.method === "PUT") {
      await options.putGate;
      const kind = path.endsWith(".layout.json") ? "LAYOUT" : path.endsWith(".model.json") ? "MODEL" : "EXPERIMENT";
      return options.putStatus === 409 && (options.conflictPath === undefined || path === options.conflictPath)
        ? { status: 409, body: { code: "VERSION_CONFLICT", message: "stale", diagnostics: [] } }
        : { body: { path, kind, version: `v-${kind.toLowerCase()}-2` } };
    }
    await options.beforeDocument?.(path);
    const document = views[path];
    return document === undefined
      ? { status: 404, body: { code: "DOCUMENT_NOT_FOUND", message: "missing", diagnostics: [] } }
      : { body: document };
  });
}

async function loaded() {
  const hook = renderHook(() => useWorkspace());
  await waitFor(() => expect(hook.result.current.loaded).not.toBeNull());
  return hook;
}

describe("useWorkspace", () => {
  it("loads the catalog and opens the first experiment with its model and layout", async () => {
    stubWorkspace();

    const { result } = await loaded();

    expect(result.current.catalog).toEqual(localizeCatalog(catalog));
    expect(result.current.experiments).toEqual([experimentPath]);
    expect(result.current.loaded?.modelPath).toBe(modelPath);
    expect(result.current.loaded?.layout?.positions.gateway).toEqual({ x: 260, y: 100 });
    expect(result.current.dirty).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("switches the catalog language without fetching again or changing documents and undo history", async () => {
    const fetchMock = stubWorkspace();
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    const edited = result.current.loaded;
    await act(() => setLanguage("ru"));
    expect(result.current.catalog?.types[1].title).toBe("Сервис");
    expect(result.current.catalog?.types[1].params[0].title).toBe("Обработчики");
    expect(result.current.loaded).toBe(edited);
    expect(result.current.dirty).toBe(true);
    act(() => result.current.undo());
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
    act(() => result.current.redo());
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);
    await act(() => setLanguage("en"));
    expect(result.current.catalog?.types[1].title).toBe("Service");
    expect(catalog.types[1].title).toBe("Service");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/catalog")).toHaveLength(1);
  });

  it("saves edits with If-Match and clears the unsaved state", async () => {
    const fetchMock = stubWorkspace();
    const { result } = await loaded();

    act(() => result.current.setParam("gateway", "handlers", 6));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await result.current.save();
    });

    const [url, init] = fetchMock.mock.calls.find(([, call]) => call?.method === "PUT")!;
    expect(url).toBe(`/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`);
    expect((init?.headers as Record<string, string>)["If-Match"]).toBe('"v-model"');
    expect(JSON.parse(String(init?.body)).model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.dirty).toBe(false);
    expect(result.current.loaded?.versions.model).toBe("v-model-2");
  });

  it("reports a version conflict and reloads the stored model", async () => {
    stubWorkspace({ putStatus: 409 });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));

    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).toBe(true);
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.conflict).toBe(false);
    expect(result.current.dirty).toBe(false);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
  });

  it("preserves service scenario when opening editing undoing and saving the model", async () => {
    const scenario = [
      { type: "process", processing: { kind: "fixed", mean: "2ms" }, failureRate: "1%" },
      { type: "call", connection: "gateway-to-middle" },
      { type: "process" },
      { type: "call", connection: "gateway-to-middle" },
    ];
    const source = { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, scenario } } };
    const fetchMock = stubWorkspace({ documents: {
      [modelPath]: { ...documentViews[modelPath], content: { model: source } },
    } });
    const { result } = await loaded();
    expect(result.current.loaded?.model.blocks.gateway.scenario).toEqual(scenario);
    act(() => result.current.setParam("gateway", "handlers", 6));
    act(() => result.current.undo());
    act(() => result.current.redo());
    await act(async () => { await result.current.save(); });
    const [, init] = fetchMock.mock.calls.find(([, call]) => call?.method === "PUT")!;
    expect(JSON.parse(String(init?.body)).model.blocks.gateway.scenario).toEqual(scenario);
    expect(result.current.dirty).toBe(false);
  });

  it("reports documents that cannot be opened", async () => {
    stubWorkspace();
    const { result } = await loaded();

    await act(async () => {
      await result.current.open("missing.experiment.json");
    });

    expect(result.current.problem?.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("reports a layout reference that leaves the workspace or cannot be read", async () => {
    const withLayout = (path: string, layoutRef: string): DocumentView => ({
      path,
      kind: "EXPERIMENT",
      version: "v-broken",
      content: { experiment: { ...experiment, layoutRef } },
    });
    const outside = "retry-storm/outside.experiment.json";
    const missing = "retry-storm/missing.experiment.json";
    stubWorkspace({
      documents: { [outside]: withLayout(outside, "../../outside.layout.json"), [missing]: withLayout(missing, "missing.layout.json") },
    });
    const { result } = await loaded();

    await act(async () => {
      await result.current.open(outside);
    });
    expect(result.current.problem?.message).toContain("layoutRef");

    await act(async () => {
      await result.current.open(missing);
    });
    expect(result.current.problem?.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("keeps unsaved edits unless opening discards them", async () => {
    stubWorkspace();
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));

    let opened = true;
    await act(async () => {
      opened = await result.current.open(experimentPath);
    });
    expect(opened).toBe(false);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);

    await act(async () => {
      opened = await result.current.open(experimentPath, true);
    });
    expect(opened).toBe(true);
    expect(result.current.dirty).toBe(false);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
  });

  it("reports loading while an experiment opens", async () => {
    stubWorkspace();
    const { result } = await loaded();

    let opening: Promise<boolean> = Promise.resolve(false);
    act(() => {
      opening = result.current.open(experimentPath);
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await opening;
    });
    expect(result.current.loading).toBe(false);
  });

  it("does not open another experiment while saving", async () => {
    let release: () => void = () => {};
    const putGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubWorkspace({ putGate });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));

    let saving: Promise<boolean> = Promise.resolve(true);
    act(() => {
      saving = result.current.save();
    });
    expect(result.current.saving).toBe(true);
    let opened = true;
    await act(async () => {
      opened = await result.current.open(experimentPath, true);
    });
    expect(opened).toBe(false);

    release();
    await act(async () => {
      await saving;
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("does not retry a stale save until the model is reloaded", async () => {
    const fetchMock = stubWorkspace({ putStatus: 409 });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    await act(async () => { await result.current.save(); });

    await act(async () => { await result.current.save(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(result.current.conflict).toBe(true);
    expect(result.current.dirty).toBe(true);

    await act(async () => { await result.current.reload(); });
    act(() => result.current.setParam("gateway", "handlers", 8));
    await act(async () => { await result.current.save(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
  });

  it("does not send another save while the first PUT is in flight", async () => {
    const gate = deferred();
    const fetchMock = stubWorkspace({ putGate: gate.promise });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
      void result.current.save();
    });
    await act(async () => { await result.current.save(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);

    gate.release();
    await act(async () => { await saving; });
    expect(result.current.saving).toBe(false);
  });

  it("keeps edits made during PUT dirty and saves them with the returned version", async () => {
    const gate = deferred();
    const fetchMock = stubWorkspace({ putGate: gate.promise });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(); });
    act(() => result.current.setParam("gateway", "handlers", 8));

    gate.release();
    await act(async () => { await saving; });
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(8);
    expect(result.current.loaded?.saved.model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.loaded?.versions.model).toBe("v-model-2");
    expect(result.current.dirty).toBe(true);

    await act(async () => { await result.current.save(); });
    const [, init] = fetchMock.mock.calls.filter(([, call]) => call?.method === "PUT")[1];
    expect((init?.headers as Record<string, string>)["If-Match"]).toBe('"v-model-2"');
    expect(JSON.parse(String(init?.body)).model.blocks.gateway.params.handlers).toBe(8);
    expect(result.current.dirty).toBe(false);
  });

  it("ignores an older open response after a newer experiment opens", async () => {
    const gate = deferred();
    const slowPath = "retry-storm/slow.experiment.json";
    const newerPath = "retry-storm/newer.experiment.json";
    stubWorkspace({
      beforeDocument: async (path) => { if (path === slowPath) await gate.promise; },
      documents: {
        [slowPath]: { path: slowPath, kind: "EXPERIMENT", version: "v-slow", content: { experiment } },
        [newerPath]: { path: newerPath, kind: "EXPERIMENT", version: "v-newer", content: { experiment } },
      },
    });
    const { result } = await loaded();
    let opening!: Promise<boolean>;
    act(() => { opening = result.current.open(slowPath); });
    await act(async () => { await result.current.open(newerPath); });
    expect(result.current.loaded?.experimentPath).toBe(newerPath);
    expect(result.current.loading).toBe(false);

    gate.release();
    await act(async () => { await opening; });
    expect(result.current.loaded?.experimentPath).toBe(newerPath);
    expect(result.current.loading).toBe(false);
    expect(result.current.problem).toBeNull();
  });

  it.each(["reload", "open"] as const)("preserves the conflict after a failed %s", async (operation) => {
    let rejectReads = false;
    const fetchMock = stubWorkspace({
      putStatus: 409,
      beforeDocument: async () => { if (rejectReads) throw new Error("offline"); },
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    await act(async () => { await result.current.save(); });
    expect(result.current.conflict).toBe(true);

    rejectReads = true;
    await act(async () => {
      if (operation === "reload") await result.current.reload();
      else await result.current.open("retry-storm/other.experiment.json", true);
    });
    expect(result.current.problem?.message).toBe("offline");
    expect(result.current.loaded?.experimentPath).toBe(experimentPath);
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.conflict).toBe(true);

    await act(async () => { await result.current.save(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    expect(result.current.dirty).toBe(true);
  });

  it("blocks a same-turn save after open before an old PUT can affect the new document", async () => {
    const openGate = deferred();
    const putGate = deferred();
    const newerPath = "retry-storm/newer.experiment.json";
    const newerModelPath = "retry-storm/newer.model.json";
    const newerModel = {
      ...model,
      blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 12 } } },
    };
    const fetchMock = stubWorkspace({
      putGate: putGate.promise,
      beforeDocument: async (path) => { if (path === newerPath) await openGate.promise; },
      documents: {
        [newerPath]: {
          path: newerPath, kind: "EXPERIMENT", version: "v-new-experiment",
          content: { experiment: { ...experiment, modelRef: "newer.model.json" } },
        },
        [newerModelPath]: { path: newerModelPath, kind: "MODEL", version: "v-new-model", content: { model: newerModel } },
      },
    });
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    let opening!: Promise<boolean>;
    let saving!: Promise<boolean>;
    act(() => {
      opening = result.current.open(newerPath, true);
      saving = result.current.save();
    });

    openGate.release();
    await act(async () => { await opening; });
    putGate.release();
    await act(async () => { await saving; });
    expect(result.current.loaded?.experimentPath).toBe(newerPath);
    expect(result.current.loaded?.versions.model).toBe("v-new-model");
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(12);
    expect(result.current.loaded?.saved.model.blocks.gateway.params.handlers).toBe(12);
    expect(result.current.dirty).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });

  it("blocks parameter edits as soon as opening starts and until it finishes", async () => {
    const openGate = deferred();
    let pauseReads = false;
    stubWorkspace({ beforeDocument: async () => { if (pauseReads) await openGate.promise; } });
    const { result } = await loaded();
    pauseReads = true;
    let opening!: Promise<boolean>;
    act(() => {
      opening = result.current.open(experimentPath);
      result.current.setParam("gateway", "handlers", 6);
    });
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setParam("gateway", "handlers", 8));
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);

    openGate.release();
    await act(async () => { await opening; });
    act(() => result.current.setParam("gateway", "handlers", 10));
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(10);
    expect(result.current.dirty).toBe(true);
  });
});


describe("editor commands and history", () => {
  it("undoes and redoes parameter commands without changing other documents or adding defaults", async () => {
    stubWorkspace();
    const { result } = await loaded();
    const initial = structuredClone(result.current.loaded);
    act(() => result.current.setParam("gateway", "handlers", 6));
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.loaded).toEqual(initial);
    expect(result.current.dirty).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.loaded?.layout).toEqual(layout);
    expect(result.current.loaded?.experiment).toEqual(experiment);
    expect(result.current.loaded?.model.blocks.gateway.params).not.toHaveProperty("failureRate");
  });

  it("keeps 100 undo steps and discards redo after a new command", async () => {
    stubWorkspace();
    const { result } = await loaded();
    act(() => {
      for (let handlers = 5; handlers <= 124; handlers++) result.current.setParam("gateway", "handlers", handlers);
    });
    act(() => { for (let i = 0; i < 100; i++) result.current.undo(); });
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(24);
    expect(result.current.canUndo).toBe(false);
    act(() => { for (let i = 0; i < 100; i++) result.current.redo(); });
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(124);
    act(() => result.current.undo());
    act(() => result.current.setParam("gateway", "handlers", 7));
    expect(result.current.canRedo).toBe(false);
  });

  it("ignores commands that leave the documents structurally equal", async () => {
    stubWorkspace();
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 4));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setParam("gateway", "handlers", 6));
    act(() => result.current.setParam("gateway", "handlers", 4));
    expect(result.current.dirty).toBe(false);
  });

  it("keeps history after saving and uses the saved version when saving undo", async () => {
    const fetchMock = stubWorkspace();
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    await act(async () => { await result.current.save(); });
    act(() => result.current.undo());
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(4);
    expect(result.current.dirty).toBe(true);
    await act(async () => { await result.current.save(); });
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(puts[1][1]?.headers).toMatchObject({ "If-Match": '"v-model-2"' });
    expect(result.current.dirty).toBe(false);
    act(() => result.current.redo());
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.dirty).toBe(true);
  });

  it.each(["open", "reload"] as const)("clears both histories after %s", async (operation) => {
    stubWorkspace();
    const { result } = await loaded();
    act(() => result.current.setParam("gateway", "handlers", 6));
    act(() => result.current.setParam("gateway", "handlers", 8));
    act(() => result.current.undo());
    await act(async () => {
      if (operation === "open") await result.current.open(experimentPath, true);
      else await result.current.reload();
    });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("restores all documents changed by one command with one undo and redo", async () => {
    stubWorkspace();
    const { result } = await loaded();
    const initial = structuredClone(result.current.loaded);
    act(() => result.current.execute((documents) => ({
      model: { ...documents.model, description: "Edited model" },
      layout: { ...documents.layout, positions: { ...documents.layout.positions, gateway: { x: 12, y: 34 } } },
      experiment: { ...documents.experiment, description: "Edited experiment" },
    })));
    const edited = structuredClone(result.current.loaded);
    expect(result.current.dirtyDocuments).toEqual({ layout: true, model: true, experiment: true });
    act(() => result.current.undo());
    expect(result.current.loaded).toEqual(initial);
    act(() => result.current.redo());
    expect(result.current.loaded).toEqual(edited);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });
});

describe("saving editor documents", () => {
  function changeAll(result: Awaited<ReturnType<typeof loaded>>["result"]) {
    act(() => result.current.execute((documents) => ({
      model: { ...documents.model, description: "Edited model" },
      layout: { ...documents.layout, positions: { ...documents.layout.positions, gateway: { x: 12, y: 34 } } },
      experiment: { ...documents.experiment, description: "Edited experiment" },
    })));
  }

  it("writes layout, model and experiment in order with each document's version", async () => {
    const fetchMock = stubWorkspace();
    const { result } = await loaded();
    changeAll(result);
    await act(async () => { await result.current.save(); });
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(puts.map(([url]) => new URL(String(url), "http://localhost").searchParams.get("path")))
      .toEqual([layoutPath, modelPath, experimentPath]);
    expect(puts.map(([, init]) => (init?.headers as Record<string, string>)["If-Match"]))
      .toEqual(['"v-layout"', '"v-model"', '"v-experiment"']);
    expect(JSON.parse(String(puts[0][1]?.body))).toEqual({ layout: result.current.loaded?.layout });
    expect(JSON.parse(String(puts[1][1]?.body))).toEqual({ model: result.current.loaded?.model });
    expect(JSON.parse(String(puts[2][1]?.body))).toEqual({ experiment: result.current.loaded?.experiment });
    expect(result.current.dirtyDocuments).toEqual({ layout: false, model: false, experiment: false });
  });

  it("stops at a 409 on the model, retains the saved layout and blocks further saves", async () => {
    const fetchMock = stubWorkspace({ putStatus: 409, conflictPath: modelPath });
    const { result } = await loaded();
    changeAll(result);
    await act(async () => { await result.current.save(); });
    expect(result.current.conflictPath).toBe(modelPath);
    expect(result.current.dirtyDocuments).toEqual({ layout: false, model: true, experiment: true });
    expect(result.current.loaded?.versions.layout).toBe("v-layout-2");
    expect(result.current.loaded?.versions.model).toBe("v-model");
    expect(result.current.loaded?.versions.experiment).toBe("v-experiment");
    await act(async () => { await result.current.save(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
    act(() => result.current.undo());
    expect(result.current.loaded?.layout).toEqual(layout);
    expect(result.current.dirtyDocuments.layout).toBe(true);
  });

  it("creates a missing layout and its relative reference in the same history step without If-Match", async () => {
    const withoutLayout = { ...experiment, layoutRef: null };
    const fetchMock = stubWorkspace({ documents: {
      [experimentPath]: { ...documentViews[experimentPath], content: { experiment: withoutLayout } },
    } });
    const { result } = await loaded();
    const initial = structuredClone(result.current.loaded);
    expect(result.current.dirty).toBe(false);
    act(() => result.current.execute((documents) => ({ ...documents,
      layout: { ...documents.layout, positions: { gateway: { x: 10, y: 20 } } },
    })));
    expect(result.current.loaded?.experiment.layoutRef).toBe("retry-storm.layout.json");
    act(() => result.current.undo());
    expect(result.current.loaded).toEqual(initial);
    act(() => result.current.redo());
    await act(async () => { await result.current.save(); });
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(puts.map(([url]) => new URL(String(url), "http://localhost").searchParams.get("path")))
      .toEqual([layoutPath, experimentPath]);
    expect(puts[0][1]?.headers).not.toHaveProperty("If-Match");
    expect(puts[1][1]?.headers).toMatchObject({ "If-Match": '"v-experiment"' });
    act(() => result.current.undo());
    expect(result.current.loaded?.layout.positions).toEqual({});
    expect(result.current.loaded?.experiment.layoutRef).toBeNull();
    expect(result.current.dirtyDocuments).toEqual({ layout: true, model: false, experiment: true });
  });
});


/** In-memory HTTP boundary with the server's create-only and If-Match semantics. */
function storedWorkspace() {
  const documents = structuredClone(documentViews);
  documents[experimentPath].content.experiment!.layoutRef = null;
  delete documents[layoutPath];
  let revision = 0;
  let conflictNext: string | null = null;
  const conflict = () => ({ status: 409, body: { code: "VERSION_CONFLICT", message: "changed", diagnostics: [] } });
  const fetchMock = stubFetch((url, init) => {
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url === "/api/v1/workspace/documents") return { body: Object.values(documents).map(view => ({ ...view, modelRef: view.content.experiment?.modelRef ?? null })) };
    const path = new URL(url, "http://localhost").searchParams.get("path")!;
    if (init?.method === "PUT") {
      if (path === conflictNext) { conflictNext = null; return conflict(); }
      const version = (init.headers as Record<string, string>)["If-Match"];
      const stored = documents[path];
      if (stored === undefined ? version !== undefined : version !== `"${stored.version}"`) return conflict();
      const content = JSON.parse(String(init.body)) as DocumentContent;
      const kind = content.layout != null ? "LAYOUT" : content.model != null ? "MODEL" : "EXPERIMENT";
      documents[path] = { path, kind, version: `stored-${++revision}`, content };
      return { body: documents[path] };
    }
    return documents[path] === undefined
      ? { status: 404, body: { code: "DOCUMENT_NOT_FOUND", message: "missing", diagnostics: [] } }
      : { body: structuredClone(documents[path]) };
  });
  return { documents, fetchMock, conflictOnce: (path: string) => { conflictNext = path; } };
}

it("creates a referenced layout even when a later command returns its content to empty", async () => {
  const { documents } = storedWorkspace();
  const { result } = await loaded();
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { gateway: { x: 1, y: 2 } } } })));
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: {} } })));
  await act(async () => { await result.current.save(); });
  expect(documents[layoutPath]?.content.layout?.positions).toEqual({});
  expect(documents[experimentPath].content.experiment?.layoutRef).toBe("retry-storm.layout.json");
  await act(async () => { await result.current.reload(); });
  expect(result.current.problem).toBeNull();
  expect(result.current.dirty).toBe(false);
});

it("can edit a generated layout again after save, undo, save and reload", async () => {
  const { documents } = storedWorkspace();
  const { result } = await loaded();
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { gateway: { x: 1, y: 2 } } } })));
  await act(async () => { await result.current.save(); });
  act(() => result.current.undo());
  await act(async () => { await result.current.save(); });
  expect(documents[experimentPath].content.experiment?.layoutRef).toBeNull();
  await act(async () => { await result.current.reload(); });
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { gateway: { x: 3, y: 4 } } } })));
  await act(async () => { await result.current.save(); });
  expect(result.current.conflict).toBe(false);
  expect(result.current.dirty).toBe(false);
  expect(documents[layoutPath].content.layout?.positions.gateway).toEqual({ x: 3, y: 4 });
});

it("rereads a known created layout when a later document conflicted before the reference was saved", async () => {
  const stored = storedWorkspace();
  const { result } = await loaded();
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { gateway: { x: 1, y: 2 } } } })));
  act(() => result.current.setParam("gateway", "handlers", 6));
  stored.conflictOnce(modelPath);
  await act(async () => { await result.current.save(); });
  expect(result.current.conflictPath).toBe(modelPath);
  expect(stored.documents[layoutPath]).toBeDefined();
  await act(async () => { await result.current.reload(); });
  expect(result.current.loaded?.versions.layout).toBe(stored.documents[layoutPath].version);
  expect(result.current.loaded?.layout.positions.gateway).toEqual({ x: 1, y: 2 });
  expect(result.current.loaded?.experiment.layoutRef).toBeNull();
  expect(result.current.dirty).toBe(false);
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { gateway: { x: 3, y: 4 } } } })));
  await act(async () => { await result.current.save(); });
  expect(result.current.conflict).toBe(false);
  expect(result.current.dirty).toBe(false);
});

it("recovers an existing sibling on explicit reload after create conflict, retaining its other positions", async () => {
  const { documents } = storedWorkspace();
  documents[layoutPath] = { ...documentViews[layoutPath], content: {
    layout: { schemaVersion: 2, sizes: {}, edges: {}, positions: { client: { x: 90, y: 80 } } },
  } };
  const { result } = await loaded();
  expect(result.current.loaded?.versions.layout).toBeNull();
  expect(result.current.loaded?.layout.positions).toEqual({});
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { gateway: { x: 1, y: 2 } } } })));
  await act(async () => { await result.current.save(); });
  expect(result.current.conflictPath).toBe(layoutPath);
  await act(async () => { await result.current.reload(); });
  expect(result.current.loaded?.layout.positions).toEqual({ client: { x: 90, y: 80 } });
  expect(result.current.loaded?.experiment.layoutRef).toBeNull();
  act(() => result.current.execute((docs) => ({ ...docs, layout: { ...docs.layout, positions: { ...docs.layout.positions, gateway: { x: 3, y: 4 } } } })));
  await act(async () => { await result.current.save(); });
  expect(result.current.conflict).toBe(false);
  expect(documents[layoutPath].content.layout?.positions).toEqual({ client: { x: 90, y: 80 }, gateway: { x: 3, y: 4 } });
});

it("becomes clean after removing and restoring an optional parameter despite key ordering", async () => {
  stubWorkspace();
  const { result } = await loaded();
  act(() => result.current.setParam("gateway-to-middle", "attempts", undefined));
  act(() => result.current.setParam("gateway-to-middle", "attempts", 3));
  expect(result.current.loaded?.model).toEqual(model);
  expect(result.current.dirty).toBe(false);
});

it("does not add history or discard redo for a command that only reorders object keys", async () => {
  stubWorkspace();
  const { result } = await loaded();
  act(() => result.current.setParam("gateway", "handlers", 6));
  act(() => result.current.undo());
  act(() => result.current.execute((docs) => ({ ...docs, model: {
    ...docs.model, blocks: Object.fromEntries(Object.entries(docs.model.blocks).reverse()),
  } })));
  expect(result.current.dirty).toBe(false);
  expect(result.current.canUndo).toBe(false);
  expect(result.current.canRedo).toBe(true);
});
