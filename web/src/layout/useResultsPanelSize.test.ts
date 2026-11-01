import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useResultsPanelSize } from "./useResultsPanelSize";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it.each(["normal", "expanded"] as const)("starts collapsed after a reload with %s preferred and uses it on opening", preferred => {
  localStorage.setItem("resilience-lab.results-panel-size", preferred);
  const first = renderHook(useResultsPanelSize);
  expect(first.result.current[0]).toBe("collapsed");
  expect(localStorage.getItem("resilience-lab.results-panel-size")).toBe(preferred);
  act(() => first.result.current[1]("normal"));
  expect(first.result.current[0]).toBe(preferred);
  act(() => first.result.current[1]("collapsed"));
  expect(localStorage.getItem("resilience-lab.results-panel-size")).toBe(preferred);
  first.unmount();
  const next = renderHook(useResultsPanelSize);
  expect(next.result.current[0]).toBe("collapsed");
  act(() => next.result.current[1](current => current === "collapsed" ? "normal" : current));
  expect(next.result.current[0]).toBe(preferred);
});

it("remembers an explicit return from expanded to normal", () => {
  const { result } = renderHook(useResultsPanelSize);
  act(() => result.current[1]("expanded"));
  act(() => result.current[1]("normal"));
  act(() => result.current[1]("collapsed"));
  expect(localStorage.getItem("resilience-lab.results-panel-size")).toBe("normal");
  act(() => result.current[1]("normal"));
  expect(result.current[0]).toBe("normal");
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
