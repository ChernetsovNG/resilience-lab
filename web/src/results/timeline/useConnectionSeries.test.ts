import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ConnectionSeriesLoadRequest, DecodedConnection } from "../series";
import { SeriesLoadError } from "../series";
import { useConnectionSeries } from "./useConnectionSeries";

it("aborts obsolete connection loads across context and element changes", async () => {
  const pending: { request: ConnectionSeriesLoadRequest; resolve: (connections: DecodedConnection[]) => void }[] = [];
  const loader = { loadConnections: (request: ConnectionSeriesLoadRequest) => new Promise<DecodedConnection[]>((resolve) => pending.push({ request, resolve })) };
  const { result, rerender } = renderHook(({ variant, cell, replication, selected }) =>
    useConnectionSeries(loader, "run-1", variant, cell, replication, [selected], 4, 1),
  { initialProps: { variant: "baseline", cell: "p0", replication: 0, selected: "first-call" } });
  expect(result.current.loading).toBe(true);
  rerender({ variant: "no-retries", cell: "p1", replication: 1, selected: "second-call" });
  expect(pending[0].request.signal?.aborted).toBe(true);
  await act(async () => pending[0].resolve([{ id: "first-call", windows: [] }]));
  expect(result.current.connections).toEqual([]);
  expect(result.current.loading).toBe(true);
  await act(async () => pending[1].resolve([{ id: "second-call", windows: [] }]));
  expect(result.current.connections[0].id).toBe("second-call");
  expect(result.current.loading).toBe(false);
  expect(pending[1].request).toMatchObject({ connections: ["second-call"], fromWindow: 1, untilWindow: 4 });
});

it("shows unavailable connection series and clears it when disabled", async () => {
  const loader = { loadConnections: async () => { throw new SeriesLoadError("SERIES_NOT_FOUND", "Series are unavailable."); } };
  const { result, rerender } = renderHook(({ variant }: { variant: string | null }) =>
    useConnectionSeries(loader, "run-1", variant, "p0", 0, ["call"], 4), { initialProps: { variant: "baseline" as string | null } });
  await waitFor(() => expect(result.current.problem).toBe("Series are unavailable."));
  expect(result.current.loading).toBe(false);
  rerender({ variant: null });
  expect(result.current).toMatchObject({ connections: [], problem: null, loading: false });
});
