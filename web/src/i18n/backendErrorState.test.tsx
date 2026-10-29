import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/apiClient";
import { SeriesLoader } from "../results/series/loader";
import { useTimelineSeries } from "../results/timeline/useTimelineSeries";
import { useConnectionSeries } from "../results/timeline/useConnectionSeries";
import { useHealth } from "../components/useHealth";
import { stubFetch } from "../test/stubFetch";
import { messages } from "./index";

const catalog = messages as Record<string, string>;
afterEach(() => { delete catalog["messages.TEST_ERROR"]; vi.unstubAllGlobals(); });

function failingLoader() {
  catalog["messages.TEST_ERROR"] = "First translation {value}";
  const error = new ApiError(500, { code: "TEST_ERROR", message: "Server text", args: { value: 7 }, diagnostics: [] });
  return new SeriesLoader({ api: {
    seriesIndex: async () => { throw error; },
    seriesPart: async () => { throw new Error("No part request expected"); },
  } });
}

it("resolves a stored Timeline API failure again on render without another request", async () => {
  const loader = failingLoader();
  const view = renderHook(() => useTimelineSeries(loader, "run", "baseline", "p0", 0, ["service"], 1));
  await waitFor(() => expect(view.result.current.problem).toContain("First translation 7"));
  catalog["messages.TEST_ERROR"] = "Second translation {value}";
  view.rerender();
  expect(view.result.current.problem).toContain("Second translation 7");
});

it("resolves a stored connection API failure again on render", async () => {
  const loader = failingLoader();
  const view = renderHook(() => useConnectionSeries(loader, "run", "baseline", "p0", 0, ["call"], 1));
  await waitFor(() => expect(view.result.current.problem).toContain("First translation 7"));
  catalog["messages.TEST_ERROR"] = "Second translation {value}";
  view.rerender();
  expect(view.result.current.problem).toContain("Second translation 7");
});

it("resolves an existing backend health API error again on render", async () => {
  catalog["messages.TEST_ERROR"] = "First translation {value}";
  stubFetch(() => ({ status: 500, body: { code: "TEST_ERROR", message: "Server text", args: { value: 7 }, diagnostics: [] } }));
  const view = renderHook(() => useHealth());
  await waitFor(() => expect(view.result.current.error).toBe("First translation 7"));
  catalog["messages.TEST_ERROR"] = "Second translation {value}";
  view.rerender();
  expect(view.result.current.error).toBe("Second translation 7");
});
