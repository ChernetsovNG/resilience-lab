import { backendMessage } from "../i18n/backendMessage";
import { t } from "../i18n";
import type {
  ApiProblem,
  Catalog,
  DocumentContent,
  DocumentDraft,
  DocumentEntry,
  DocumentView,
  ExperimentEstimate,
  HealthView,
  JobView,
  RunManifest,
  RunSummary,
  SeriesIndex,
  ValidationView,
  WorkspaceChangesView,
} from "./apiTypes";

/** A failed API call with the server's problem body, or a generic one when the body is not JSON. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ApiProblem;

  constructor(status: number, problem: ApiProblem) {
    super(problem.message);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
    Object.defineProperty(this, "message", { get: () => backendMessage(this.problem) });
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new ApiError(response.status, await problemOf(response));
  }
  return response.status === 204 ? undefined as T : (await response.json()) as T;
}

async function requestText(path: string, init?: RequestInit): Promise<{ text: string; etag: string | null }> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new ApiError(response.status, await problemOf(response));
  }
  return { text: await response.text(), etag: response.headers.get("ETag") };
}

async function problemOf(response: Response): Promise<ApiProblem> {
  try {
    return (await response.json()) as ApiProblem;
  } catch {
    return { code: `HTTP_${response.status}`, get message() { return t("app.api.requestFailedWithStatus", { status: response.status }); }, diagnostics: [] };
  }
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

const documentUrl = (path: string) => `/api/v1/workspace/document?path=${encodeURIComponent(path)}`;
const signal = (value?: AbortSignal) => value === undefined ? undefined : { signal: value };
const seriesUrl = (runId: string, variant: string, cell: string, replication: number) =>
  `/api/v1/runs/${encodeURIComponent(runId)}/series/${encodeURIComponent(variant)}/${encodeURIComponent(cell)}/${replication}`;

/** Stage 1 API (ADR 0010); paths and types come from `apps/server/openapi.json`. */
export const api = {
  health: () => request<HealthView>("/api/v1/health"),
  catalog: () => request<Catalog>("/api/v1/catalog"),
  documents: () => request<DocumentEntry[]>("/api/v1/workspace/documents"),
  changes: (since?: string) => request<WorkspaceChangesView>(`/api/v1/workspace/changes${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`),
  document: (path: string) => request<DocumentView>(documentUrl(path)),
  documentText: (path: string) => requestText(`/api/v1/workspace/document/text?path=${encodeURIComponent(path)}`),
  /** Writes a document; [version] is the one it was read with, or null for a new document. */
  saveDocument: (path: string, content: DocumentContent, version: string | null) =>
    request<DocumentEntry>(documentUrl(path), json("PUT", content, version === null ? {} : { "If-Match": `"${version}"` })),
  /** Removes only the version confirmed by the user; DELETE returns an empty 204 response. */
  deleteDocument: (path: string, version: string) =>
    request<void>(documentUrl(path), { method: "DELETE", headers: { "If-Match": `"${version}"` } }),
  validate: (experiment: string, drafts: DocumentDraft[] = []) =>
    request<ValidationView>("/api/v1/validate", json("POST", { experiment, drafts })),
  estimate: (experiment: string, drafts: DocumentDraft[] = []) =>
    request<ExperimentEstimate>("/api/v1/estimate", json("POST", { experiment, drafts })),
  resumeRun: (runId: string) => request<JobView>(`/api/v1/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" }),
  submitJob: (experiment: string) => request<JobView>("/api/v1/jobs", json("POST", { experiment })),
  job: (id: string) => request<JobView>(`/api/v1/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => request<JobView>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  runSummary: (runId: string) => request<RunSummary>(`/api/v1/runs/${encodeURIComponent(runId)}/summary`),
  seriesIndex: (runId: string, variant: string, cell: string, replication: number, abort?: AbortSignal) =>
    request<SeriesIndex>(seriesUrl(runId, variant, cell, replication), signal(abort)),
  /** Browser fetch decompresses gzip; the worker, not this client, parses the returned JSON text. */
  seriesPart: (runId: string, variant: string, cell: string, replication: number, part: number, abort?: AbortSignal) =>
    requestText(`${seriesUrl(runId, variant, cell, replication)}/${part}`, signal(abort)),
  runManifest: (runId: string) => request<RunManifest>(`/api/v1/runs/${encodeURIComponent(runId)}/manifest`),
};
