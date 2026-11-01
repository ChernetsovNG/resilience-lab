import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DocumentView } from "../api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, layoutPath, modelPath } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { renameElement } from "./structure";
import { useWorkspace } from "./useWorkspace";
import { editRequestTypes, renameRequestType } from "./requestTypes";

const sibling = "questions/grid.experiment.json";
const unrelated = "other/grid.experiment.json";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

function storage(
  beforePreflight?: (documents: Record<string, DocumentView>) => void, failModelOnce = false,
  afterList?: (documents: Record<string, DocumentView>, call: number) => void,
) {
  const documents = structuredClone(documentViews);
  const question = { ...experiment, modelRef: "../retry-storm/retry-storm.model.json",
    faults: ["gateway#2", "gateway-to-middle#2"].map(target => ({ target, kind: "slowdown", from: "0ms", to: "1s", multiplier: 2 })),
    grid: [{ path: "gateway-to-middle.timeout", values: ["80ms", "90ms"] }],
    variants: [{ id: "baseline", overrides: { "gateway.handlers": 8, "gateway-to-middle.attempts": 1 } }],
  };
  documents[sibling] = { path: sibling, kind: "EXPERIMENT", version: "grid-1", content: { experiment: question } };
  documents[unrelated] = { path: unrelated, kind: "EXPERIMENT", version: "other-1",
    content: { experiment: { ...structuredClone(question), modelRef: "retry-storm.model.json" } } };
  let lists = 0, revision = 0;
  const fetchMock = stubFetch((url, init) => {
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url.startsWith("/api/v1/workspace/changes")) return { body: { cursor: "1", reset: false, changes: [] } };
    if (url === "/api/v1/workspace/documents") {
      if (++lists === 3) beforePreflight?.(documents);
      const entries = Object.values(documents).map(({ path, kind, version, content }) => ({ path, kind, version, modelRef: content.experiment?.modelRef ?? null }));
      afterList?.(documents, lists);
      return { body: entries };
    }
    const path = new URL(url, "http://test").searchParams.get("path")!;
    const view = documents[path];
    if (init?.method === "PUT") {
      if (path === modelPath && failModelOnce) {
        failModelOnce = false;
        return { status: 500, body: { code: "SAVE_FAILED", message: "Model write failed", diagnostics: [] } };
      }
      if ((init.headers as Record<string, string>)["If-Match"] !== `"${view.version}"`) {
        return { status: 409, body: { code: "VERSION_CONFLICT", message: `Changed: ${path}`, args: { path }, diagnostics: [] } };
      }
      documents[path] = { ...view, version: `saved-${++revision}`, content: JSON.parse(String(init.body)) };
      return { body: documents[path] };
    }
    return view === undefined
      ? { status: 404, body: { code: "DOCUMENT_NOT_FOUND", message: `Missing: ${path}`, args: { path }, diagnostics: [] } }
      : { body: structuredClone(view) };
  });
  return { documents, fetchMock, puts: () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT") };
}

async function opened() {
  const hook = renderHook(() => useWorkspace());
  await waitFor(() => expect(hook.result.current.loaded?.experimentPath).toBe(experimentPath));
  return hook;
}

it("saves a rename without reading an unrelated experiment removed after listing", async () => {
  const store = storage(undefined, false, (documents, call) => { if (call === 2) delete documents[unrelated]; });
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[modelPath].content.model!.blocks).toHaveProperty("entry");
  expect(store.documents[sibling].content.experiment!.faults[0].target).toBe("entry#2");
  expect(store.fetchMock.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(unrelated)))).toBe(false);
  expect(result.current.problem).toBeNull();
  expect(result.current.dirty).toBe(false);
});

it.each([false, true])("writes nothing if an owned experiment disappears before reading (recreated: %s)", async recreated => {
  const store = storage(documents => { if (recreated) documents[sibling] = original; }, false,
    (documents, call) => { if (call === 2) delete documents[sibling]; });
  const original = structuredClone(store.documents[sibling]);
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.puts()).toHaveLength(0);
  expect(result.current.problem?.code).toBe("CLIENT_ERROR");
  expect(result.current.problem?.message).toContain(sibling);
  expect(result.current.dirty).toBe(true);
});

it("composes renames across parameter edits and saves every owned experiment with its version", async () => {
  const store = storage();
  const unrelatedBefore = structuredClone(store.documents[unrelated]);
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  act(() => result.current.setParam("entry", "handlers", 7));
  act(() => result.current.execute(renameElement("entry", "api")));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  const question = store.documents[sibling].content.experiment!;
  expect(question.faults.map(fault => fault.target)).toEqual(["api#2", "api-to-middle#2"]);
  expect(question.variants[0].overrides).toEqual({ "api.handlers": 8, "api-to-middle.attempts": 1 });
  expect(question.grid).toEqual([{ path: "api-to-middle.timeout", values: ["80ms", "90ms"] }]);
  expect(store.documents[unrelated]).toEqual(unrelatedBefore);
  const write = store.puts().find(([url]) => String(url).includes(encodeURIComponent(sibling)))!;
  expect(write[1]?.headers).toMatchObject({ "If-Match": '"grid-1"' });
  expect(result.current.dirty).toBe(false);
});

it("identifies direct and automatic connection references in other questions across pending renames", async () => {
  storage();
  const { result } = await opened();
  await waitFor(() => expect(result.current.experimentsUsing("gateway")).toEqual(["grid"]));
  expect(result.current.experimentsUsing("gateway-to-middle")).toEqual(["grid"]);
  expect(result.current.experimentsUsing("middle")).toEqual(["grid"]);
  expect(result.current.experimentsUsing("dependency")).toEqual([]);
  act(() => result.current.execute(renameElement("gateway", "entry")));
  expect(result.current.experimentsUsing("entry")).toEqual(["grid"]);
  expect(result.current.experimentsUsing("entry-to-middle")).toEqual(["grid"]);
  act(() => result.current.undo());
  expect(result.current.experimentsUsing("gateway")).toEqual(["grid"]);
});

it("does not rewrite other experiments when a rename is undone before saving", async () => {
  const store = storage();
  const before = structuredClone(store.documents[sibling]);
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  act(() => result.current.undo());
  act(() => result.current.setParam("gateway", "handlers", 7));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[sibling]).toEqual(before);
  expect(store.puts()).toHaveLength(1);
});

it("applies the reverse replacement when a saved rename is undone and saved again", async () => {
  const store = storage();
  const before = structuredClone(store.documents[sibling].content);
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[sibling].content.experiment!.faults.map(fault => fault.target)).toEqual(["entry#2", "entry-to-middle#2"]);
  act(() => result.current.undo());
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[sibling].content).toEqual(before);
  expect(store.documents[modelPath].content.model!.blocks).toHaveProperty("gateway");
  expect(result.current.dirty).toBe(false);
});

it("rewrites direct connection renames and replica suffixes in another experiment", async () => {
  const store = storage();
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway-to-middle", "rpc")));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  const question = store.documents[sibling].content.experiment!;
  expect(question.faults.map(fault => fault.target)).toEqual(["gateway#2", "rpc#2"]);
  expect(question.grid![0].path).toBe("rpc.timeout");
  expect(question.variants[0].overrides).toEqual({ "gateway.handlers": 8, "rpc.attempts": 1 });
});

it.each([sibling, modelPath, layoutPath, experimentPath])("writes nothing if preflight detects a changed version of %s", async path => {
  const store = storage(documents => { documents[path].version = "external-change"; });
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.puts()).toHaveLength(0);
  expect(result.current.problem?.message).toContain(path);
  expect(result.current.dirty).toBe(true);
});

it("writes nothing when another owned experiment appears during preflight", async () => {
  const path = "questions/new.experiment.json";
  const store = storage(documents => { documents[path] = { ...structuredClone(documents[sibling]), path }; });
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.puts()).toHaveLength(0);
  expect(result.current.problem?.message).toContain(path);
});

it("writes nothing when an initially unaffected question gains a reference during preflight", async () => {
  const store = storage(documents => {
    documents[sibling].version = "new-reference";
    documents[sibling].content.experiment!.faults = [{ target: "gateway", kind: "slowdown", from: "0ms", to: "1s", multiplier: 2 }];
  });
  Object.assign(store.documents[sibling].content.experiment!, { faults: [], grid: [], variants: [{ id: "baseline", overrides: {} }] });
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.puts()).toHaveLength(0);
  expect(result.current.problem?.message).toContain(sibling);
});

it("does not reapply a successful sibling write when retrying swapped ids after a model write fails", async () => {
  const store = storage(undefined, true);
  const { result } = await opened();
  for (const [from, to] of [["gateway", "temporary"], ["middle", "gateway"], ["temporary", "middle"]]) {
    act(() => result.current.execute(renameElement(from, to)));
  }
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.documents[sibling].content.experiment!.faults.map(fault => fault.target)).toEqual(["middle#2", "middle-to-gateway#2"]);
  act(() => result.current.setParam("middle", "handlers", 7));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[sibling].content.experiment!.faults.map(fault => fault.target)).toEqual(["middle#2", "middle-to-gateway#2"]);
  expect(store.puts().filter(([url]) => String(url).includes(encodeURIComponent(sibling)))).toHaveLength(1);
});

it("can undo and save a partially written connection rename even when the open documents match their saved values", async () => {
  const store = storage(undefined, true);
  const before = structuredClone(store.documents[sibling].content);
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway-to-middle", "rpc")));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.documents[sibling].content.experiment!.grid![0].path).toBe("rpc.timeout");
  await waitFor(() => expect(result.current.experimentsUsing("rpc")).toEqual(["grid"]));
  act(() => result.current.undo());
  expect(result.current.dirty).toBe(true);
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[sibling].content).toEqual(before);
  expect(result.current.dirty).toBe(false);
});

it("preserves an external edit made to a question after a partial rename save", async () => {
  const store = storage(undefined, true);
  const { result } = await opened();
  act(() => result.current.execute(renameElement("gateway", "entry")));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  store.documents[sibling].version = "external-edit";
  store.documents[sibling].content.experiment!.faults[0].target = "gateway#2";
  const writes = store.puts().length;
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.puts()).toHaveLength(writes);
  expect(result.current.problem?.message).toContain(sibling);
  expect(store.documents[sibling].content.experiment!.faults[0].target).toBe("gateway#2");
});

const requestTypes = [
  { id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }] } },
  { id: "status", load: { points: [{ time: "0s", rate: "80/s" }] } },
];

function requestTypeStorage(failModelOnce = false) {
  const store = storage(undefined, failModelOnce);
  const client = store.documents[modelPath].content.model!.blocks.client;
  delete client.params.load;
  client.params.classes = structuredClone(requestTypes);
  store.documents[sibling].content.experiment!.variants = [{ id: "baseline", overrides: { "client.classes": structuredClone(requestTypes) } }];
  return store;
}

it("saves request type renames in sibling experiments and follows Undo after saving", async () => {
  const store = requestTypeStorage();
  const other = structuredClone(store.documents[unrelated]);
  const { result } = await opened();
  await waitFor(() => expect(result.current.requestTypeExperimentsUsing("checkout")).toEqual(["grid"]));
  act(() => result.current.execute(renameRequestType("client", 0, "order", catalog)));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  const types = () => store.documents[sibling].content.experiment!.variants[0].overrides["client.classes"] as typeof requestTypes;
  expect(types().map(type => type.id)).toEqual(["order", "status"]);
  expect(store.documents[unrelated]).toEqual(other);
  act(() => result.current.undo());
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(types().map(type => type.id)).toEqual(["checkout", "status"]);
});

it("preflights request type collisions in other experiments before writing anything", async () => {
  const store = requestTypeStorage();
  store.documents[sibling].content.experiment!.variants[0].overrides["client.classes"] = [...requestTypes, { ...requestTypes[0], id: "order" }];
  const { result } = await opened();
  act(() => result.current.execute(renameRequestType("client", 0, "order", catalog)));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect(store.puts()).toHaveLength(0);
  expect(result.current.problem?.message).toContain(sibling);
});

it("keeps partial request type writes pending when Undo restores the saved model", async () => {
  const store = requestTypeStorage(true);
  const before = structuredClone(store.documents[sibling].content);
  const { result } = await opened();
  act(() => result.current.execute(renameRequestType("client", 0, "order", catalog)));
  await act(async () => { expect(await result.current.save()).toBe(false); });
  expect((store.documents[sibling].content.experiment!.variants[0].overrides["client.classes"] as typeof requestTypes)[0].id).toBe("order");
  act(() => result.current.undo());
  expect(result.current.dirty).toBe(true);
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(store.documents[sibling].content).toEqual(before);
});

it("does not repeat swapped request type renames after a partial save and profile edit", async () => {
  const store = requestTypeStorage(true);
  const { result } = await opened();
  for (const [index, id] of [[0, "temporary"], [1, "checkout"], [0, "status"]] as const) {
    act(() => result.current.execute(renameRequestType("client", index, id, catalog)));
  }
  await act(async () => { expect(await result.current.save()).toBe(false); });
  const types = () => store.documents[sibling].content.experiment!.variants[0].overrides["client.classes"] as typeof requestTypes;
  expect(types().map(type => type.id)).toEqual(["status", "checkout"]);
  const current = result.current.loaded!.model.blocks.client.params.classes as typeof requestTypes;
  act(() => result.current.execute(editRequestTypes("client", current.map(type => ({ ...type, load: { points: [{ time: "0s", rate: "50/s" }] } })), catalog)));
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(types().map(type => type.id)).toEqual(["status", "checkout"]);
  expect(store.puts().filter(([url]) => String(url).includes(encodeURIComponent(sibling)))).toHaveLength(1);
});
