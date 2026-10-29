import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/apiClient";
import { useHealth } from "../components/useHealth";
import { SeriesLoader } from "../results/series/loader";
import { decodeSeriesPart } from "../results/series/decode";
import { useTimelineSeries } from "../results/timeline/useTimelineSeries";
import { useConnectionSeries } from "../results/timeline/useConnectionSeries";
import { problemOf } from "../workspace/useWorkspace";
import { setLanguage } from "./index";

afterEach(() => { vi.unstubAllGlobals(); setLanguage("en"); localStorage.clear(); });

it("translates a retained web error while keeping API messages verbatim", async () => {
  const apiProblem = { code: "SERIES_NOT_FOUND", message: "Original API message", diagnostics: [] };
  const apiError = new ApiError(404, apiProblem);
  const loader = new SeriesLoader({ api: {
    seriesIndex: async () => { throw apiError; }, seriesPart: async () => ({ text: "", etag: null }),
  } });
  const failure = await loader.load({ runId: "run", variant: "baseline", cell: "p0", replication: 0,
    nodes: ["gateway"], fromWindow: 0, untilWindow: 1 }).catch((error: unknown) => error);
  if (!(failure instanceof Error)) throw new Error("Expected a series loading error");
  const failedLoader = { load: async () => { throw failure; }, loadConnections: async () => { throw failure; } };
  const { result, rerender } = renderHook(() => ({
    nodes: useTimelineSeries(failedLoader, "run", "baseline", "p0", 0, ["gateway"], 1),
    connections: useConnectionSeries(failedLoader, "run", "baseline", "p0", 0, ["call"], 1),
  }));
  await waitFor(() => expect(result.current.nodes.problem).toContain("Series are unavailable"));
  setLanguage("ru");
  rerender();
  expect(result.current.nodes.problem).toContain("недоступны");
  expect(result.current.connections.problem).toContain("недоступны");
  expect(problemOf(apiError)).toBe(apiProblem);
  expect(problemOf(apiError).message).toBe("Original API message");
});

it("translates schema errors already returned by the series parser", () => {
  let failure: unknown;
  try { decodeSeriesPart('{"schemaVersion":999}'); } catch (error) { failure = error; }
  if (!(failure instanceof Error)) throw new Error("Expected an unsupported schema error");
  expect(failure.message).toBe("Unsupported series part schema version: 999");
  setLanguage("ru");
  expect(failure.message).toBe("Неподдерживаемая версия схемы части рядов: 999");
});

it("refreshes non-JSON HTTP fallback text inside health and series errors", async () => {
  vi.stubGlobal("fetch", async () => new Response("Unavailable", { status: 503 }));
  const { result, rerender } = renderHook(() => useHealth());
  await waitFor(() => expect(result.current.error).toBe("Request failed with status 503"));
  const problem = { code: "HTTP_503", get message() { return result.current.error!; }, diagnostics: [] };
  const loader = new SeriesLoader({ api: {
    seriesIndex: async () => { throw new ApiError(503, problem); }, seriesPart: async () => ({ text: "", etag: null }),
  } });
  const failure = await loader.load({ runId: "run", variant: "baseline", cell: "p0", replication: 0,
    nodes: ["gateway"], fromWindow: 0, untilWindow: 1 }).catch((error: unknown) => error);
  if (!(failure instanceof Error)) throw new Error("Expected a series loading error");
  setLanguage("ru");
  rerender();
  expect(result.current.error).toBe("Запрос завершился со статусом 503");
  expect(failure.message).toContain("Запрос завершился со статусом 503");
  expect(failure.message).not.toContain("Request failed");
});
