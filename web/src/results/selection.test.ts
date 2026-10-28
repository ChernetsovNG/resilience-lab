import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useResultsSelection } from "./selection";

it("shares point, replication and window independently of editor history and resets for a new run", () => {
  const { result, rerender } = renderHook(({ run }) => useResultsSelection(run), { initialProps: { run: "run-1" } });
  expect(result.current.selection).toEqual({ pointId: "p0", replication: 0, window: null });
  act(() => result.current.select({ pointId: "p2", replication: 1, window: 30 }));
  act(() => result.current.select({ replication: 0 }));
  expect(result.current.selection).toEqual({ pointId: "p2", replication: 0, window: 30 });
  rerender({ run: "run-2" });
  expect(result.current.selection).toEqual({ pointId: "p0", replication: 0, window: null });
});
