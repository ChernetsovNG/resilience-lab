import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useResultsPanelSize } from "./useResultsPanelSize";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("restores expanded results after a remount", () => {
  const first = renderHook(useResultsPanelSize);
  expect(first.result.current[0]).toBe("collapsed");
  act(() => first.result.current[1]("expanded"));
  first.unmount();
  const next = renderHook(useResultsPanelSize);
  expect(next.result.current[0]).toBe("expanded");
  act(() => next.result.current[1]("normal"));
  next.unmount();
  expect(renderHook(useResultsPanelSize).result.current[0]).toBe("normal");
});

it.each(["invalid", "null", "{}"])("defaults to collapsed for invalid state %s", saved => {
  localStorage.setItem("resilience-lab.results-panel-size", saved);
  expect(renderHook(useResultsPanelSize).result.current[0]).toBe("collapsed");
});

it("allows expansion and restoration when storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
  const { result } = renderHook(useResultsPanelSize);
  act(() => result.current[1]("expanded"));
  expect(result.current[0]).toBe("expanded");
  act(() => result.current[1]("normal"));
  expect(result.current[0]).toBe("normal");
});
