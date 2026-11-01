import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test/stubFetch";
import { ApiError, api } from "./apiClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  it("reads documents by encoded path", async () => {
    const fetchMock = stubFetch(() => ({ body: { path: "a/b.model.json", kind: "MODEL", version: "v1", content: { model: { schemaVersion: 6, blocks: {}, connections: [], description: null, notes: null }, experiment: null, layout: null } } }));

    const document = await api.document("a/b.model.json");

    expect(document.path).toBe("a/b.model.json");
    expect(document.content.model?.schemaVersion).toBe(6);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/workspace/document?path=a%2Fb.model.json", undefined);
  });

  it("saves a document with its version in If-Match", async () => {
    const fetchMock = stubFetch(() => ({ body: { path: "m.model.json", kind: "MODEL", version: "v2" } }));

    await api.saveDocument("m.model.json", { model: { schemaVersion: 6, blocks: {}, connections: [] } }, "v1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/workspace/document?path=m.model.json");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init?.headers as Record<string, string>)["If-Match"]).toBe('"v1"');
    expect(JSON.parse(String(init?.body))).toEqual({ model: { schemaVersion: 6, blocks: {}, connections: [] } });
  });

  it("creates a document without If-Match", async () => {
    const fetchMock = stubFetch(() => ({ body: { path: "new.layout.json", kind: "LAYOUT", version: "v1" } }));

    await api.saveDocument("new.layout.json", { layout: { schemaVersion: 2, sizes: {}, edges: {}, positions: {} } }, null);

    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["If-Match"]).toBeUndefined();
  });

  it("submits and cancels jobs and reads run artifacts", async () => {
    const fetchMock = stubFetch((url) => ({ body: url.includes("/summary")
      ? { schemaVersion: 1, experiment: "e.experiment.json", variants: [] }
      : url.includes("/manifest") ? { schemaVersion: 4, experiment: "e.experiment.json" }
        : { id: "job 1", experiment: "e.experiment.json", status: "QUEUED", runId: "run-1", completedTasks: 0, totalTasks: 1, diagnostics: [], error: null } }));

    await api.submitJob("e.experiment.json");
    await api.job("job 1");
    await api.runSummary("run/1");
    await api.runManifest("run/1");
    await api.cancelJob("job 1");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/jobs",
      "/api/v1/jobs/job%201",
      "/api/v1/runs/run%2F1/summary",
      "/api/v1/runs/run%2F1/manifest",
      "/api/v1/jobs/job%201/cancel",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ experiment: "e.experiment.json" });
    expect(fetchMock.mock.calls[4][1]?.method).toBe("POST");
  });

  it("reads health, catalog and workspace documents", async () => {
    const fetchMock = stubFetch((url) => ({ body: url.endsWith("/health")
      ? { status: "UP", applicationVersion: "test", kslVersion: "test" }
      : url.endsWith("/catalog") ? { schemaVersion: 1, assumptions: [], types: [] }
      : [{ path: "m.model.json", kind: "MODEL", version: "v1" }] }));

    expect((await api.health()).status).toBe("UP");
    expect((await api.catalog()).types).toEqual([]);
    expect(await api.documents()).toEqual([{ path: "m.model.json", kind: "MODEL", version: "v1" }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/health", "/api/v1/catalog", "/api/v1/workspace/documents",
    ]);
  });

  it("reads workspace changes with an encoded optional cursor", async () => {
    const fetchMock = stubFetch(() => ({ body: { cursor: "gen:13", reset: false, changes: [] } }));

    await api.changes("gen:12");
    await api.changes();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/workspace/changes?since=gen%3A12",
      "/api/v1/workspace/changes",
    ]);
  });

  it("turns error bodies into ApiError", async () => {
    stubFetch(() => ({ status: 409, body: { code: "VERSION_CONFLICT", message: "stale", diagnostics: [] } }));

    const error = await api.catalog().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).problem.code).toBe("VERSION_CONFLICT");
  });

  it("keeps the status when an error has no JSON body", async () => {
    stubFetch(() => ({ status: 502 }));

    const error = (await api.health().catch((reason: unknown) => reason)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.problem).toEqual({ code: "HTTP_502", message: "Request failed with status 502", diagnostics: [] });
  });

  it("reads series parts as raw JSON with their ETag and abort signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const url = String(args[0]);
      return url.endsWith("/1")
        ? new Response("{\"part\":true}", { headers: { ETag: "\"abc123\"" } })
        : new Response(JSON.stringify({ schemaVersion: 1, endMs: 100, windowMs: 10, parts: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const index = await api.seriesIndex("run/1", "no retries", "p0", 0, controller.signal);
    const part = await api.seriesPart("run/1", "no retries", "p0", 0, 1, controller.signal);

    expect(index.windowMs).toBe(10);
    expect(part).toEqual({ text: "{\"part\":true}", etag: "\"abc123\"" });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.signal])).toEqual([
      ["/api/v1/runs/run%2F1/series/no%20retries/p0/0", controller.signal],
      ["/api/v1/runs/run%2F1/series/no%20retries/p0/0/1", controller.signal],
    ]);
  });
});
