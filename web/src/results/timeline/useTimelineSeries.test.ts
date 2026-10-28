import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { NodeSeriesMetrics, SeriesLoadRequest } from "../series";
import { SeriesLoadError } from "../series";
import { useTimelineSeries } from "./useTimelineSeries";

it("aborts obsolete requests and never shows a late reply under a new selection", async () => {
  const pending: { request: SeriesLoadRequest; resolve: (nodes: NodeSeriesMetrics[]) => void }[] = [];
  const loader = { load: (request: SeriesLoadRequest) => new Promise<NodeSeriesMetrics[]>((resolve) => pending.push({ request, resolve })) };
  const { result, rerender } = renderHook(({ variant, cell, replication }) =>
    useTimelineSeries(loader, "run-1", variant, cell, replication, ["dependency"], 110),
  { initialProps: { variant: "baseline", cell: "p0", replication: 0 } });
  expect(result.current.loading).toBe(true);
  rerender({ variant: "no-retries", cell: "p1", replication: 1 });
  expect(pending[0].request.signal?.aborted).toBe(true);
  await act(async () => pending[0].resolve([{ id: "obsolete", windows: [] }]));
  expect(result.current.nodes).toEqual([]);
  expect(result.current.loading).toBe(true);
  await act(async () => pending[1].resolve([{ id: "dependency", windows: [] }]));
  expect(result.current.nodes[0].id).toBe("dependency");
  expect(result.current.loading).toBe(false);
});

it("shows unavailable series as a readable state", async () => {
  const loader = { load: async () => { throw new SeriesLoadError("SERIES_NOT_FOUND", "Series are unavailable."); } };
  const { result } = renderHook(() => useTimelineSeries(loader, "run-1", "baseline", "p0", 0, ["dependency"], 110));
  await waitFor(() => expect(result.current.problem).toBe("Series are unavailable."));
  expect(result.current.loading).toBe(false);
});
