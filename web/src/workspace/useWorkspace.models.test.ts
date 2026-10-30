import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/apiClient";
import type { DocumentView } from "../api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, layoutPath, modelPath } from "../test/fixtures";
import { useWorkspace } from "./useWorkspace";

const second = "questions/second.experiment.json";
const orphan = "bare/bare.model.json";
function server() {
  const views: Record<string, DocumentView> = structuredClone({ ...documentViews,
    [second]: { path: second, kind: "EXPERIMENT", version: "s", content: { experiment: {
      ...experiment, modelRef: "../retry-storm/retry-storm.model.json", layoutRef: "../retry-storm/retry-storm.layout.json",
    } } },
    [orphan]: { ...documentViews[modelPath], path: orphan },
  });
  vi.spyOn(api, "catalog").mockResolvedValue(catalog);
  vi.spyOn(api, "changes").mockResolvedValue({ cursor: "test:0", reset: false, changes: [] });
  vi.spyOn(api, "documents").mockImplementation(async () => Object.values(views).map(view => ({
    path: view.path, kind: view.kind, version: view.version, modelRef: view.content.experiment?.modelRef ?? null,
  })));
  vi.spyOn(api, "document").mockImplementation(async path => {
    if (views[path] === undefined) throw new Error(`Unexpected read ${path}`);
    return views[path];
  });
  vi.spyOn(api, "saveDocument").mockImplementation(async (path, content) => {
    const kind = content.experiment ? "EXPERIMENT" : content.model ? "MODEL" : "LAYOUT";
    return views[path] = { path, kind, version: "saved", content };
  });
  return views;
}
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("selects models and exposes only experiments referring to the selected model", async () => {
  server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded).not.toBeNull());
  expect(result.current.models).toEqual([orphan, modelPath]);
  await act(async () => { await result.current.openModel(modelPath); });
  expect(result.current.experiments).toEqual([second, experimentPath]);
  expect(result.current.loaded?.experimentPath).toBe(second);
});

it("restores each model's last experiment across model switches and browser reloads", async () => {
  server();
  const first = renderHook(() => useWorkspace());
  await waitFor(() => expect(first.result.current.loaded).not.toBeNull());
  await act(async () => { await first.result.current.open(experimentPath); });
  await act(async () => { await first.result.current.openModel(orphan); });
  await act(async () => { await first.result.current.openModel(modelPath); });
  expect(first.result.current.loaded?.experimentPath).toBe(experimentPath);
  first.unmount();
  const next = renderHook(() => useWorkspace());
  await waitFor(() => expect(next.result.current.loaded?.experimentPath).toBe(experimentPath));
});

it("opens a model without experiments and creates its default only on first save", async () => {
  const views = server();
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.loaded?.modelPath).toBe(orphan));
  expect(result.current.loaded?.experiment).toMatchObject({ modelRef: "bare.model.json", execution: { replications: 10 }, variants: [{ id: "baseline", overrides: {} }] });
  expect(result.current.loaded?.versions.experiment).toBeNull();
  expect(api.saveDocument).not.toHaveBeenCalled();
  await act(async () => { expect(await result.current.save()).toBe(true); });
  expect(views["bare/bare.experiment.json"].content.experiment?.modelRef).toBe("bare.model.json");
  expect(result.current.loaded?.versions.experiment).toBe("saved");
  expect(result.current.dirty).toBe(false);
  expect(api.document).not.toHaveBeenCalledWith("bare/bare.layout.json");
  expect(api.document).not.toHaveBeenCalledWith(layoutPath);
});

it("keeps a model's other questions accessible when the first experiment cannot be opened", async () => {
  const views = server();
  delete views[orphan];
  views[second].content.experiment!.layoutRef = "missing.layout.json";
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => expect(result.current.problem).not.toBeNull());
  expect(result.current.experiments).toEqual([second, experimentPath]);
  await act(async () => { expect(await result.current.open(experimentPath)).toBe(true); });
  expect(result.current.loaded?.modelPath).toBe(modelPath);
  expect(result.current.loaded?.experimentPath).toBe(experimentPath);
});
