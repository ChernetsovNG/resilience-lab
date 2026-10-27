import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentView } from "../api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, modelPath } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { useWorkspace } from "./useWorkspace";

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function stubWorkspace(options: { putStatus?: number; putGate?: Promise<void>; beforeDocument?: (path: string) => Promise<void>; documents?: Record<string, DocumentView> } = {}) {
  const views = { ...documentViews, ...options.documents };
  return stubFetch(async (url, init) => {
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url === "/api/v1/workspace/documents") {
      return { body: Object.values(documentViews).map(({ path, kind, version }) => ({ path, kind, version })) };
    }
    if (init?.method === "PUT") {
      await options.putGate;
      return options.putStatus === 409
        ? { status: 409, body: { code: "VERSION_CONFLICT", message: "stale", diagnostics: [] } }
        : { body: { path: modelPath, kind: "MODEL", version: "v-model-2" } };
    }
    const path = decodeURIComponent(url.split("path=")[1] ?? "");
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

    expect(result.current.catalog).toEqual(catalog);
    expect(result.current.experiments).toEqual([experimentPath]);
    expect(result.current.loaded?.modelPath).toBe(modelPath);
    expect(result.current.loaded?.layout?.positions.gateway).toEqual({ x: 260, y: 100 });
    expect(result.current.dirty).toBe(false);
    expect(result.current.loading).toBe(false);
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
    expect(result.current.loaded?.modelVersion).toBe("v-model-2");
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

    let saving: Promise<void> = Promise.resolve();
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
    let saving!: Promise<void>;
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
    let saving!: Promise<void>;
    act(() => { saving = result.current.save(); });
    act(() => result.current.setParam("gateway", "handlers", 8));

    gate.release();
    await act(async () => { await saving; });
    expect(result.current.loaded?.model.blocks.gateway.params.handlers).toBe(8);
    expect(result.current.loaded?.savedModel.blocks.gateway.params.handlers).toBe(6);
    expect(result.current.loaded?.modelVersion).toBe("v-model-2");
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
});
