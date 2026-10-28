import type {
  ApiProblem,
  Catalog,
  DocumentContent,
  DocumentDraft,
  DocumentEntry,
  DocumentView,
  HealthView,
  JobView,
  RunSummary,
  ValidationView,
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
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new ApiError(response.status, await problemOf(response));
  }
  return (await response.json()) as T;
}

async function problemOf(response: Response): Promise<ApiProblem> {
  try {
    return (await response.json()) as ApiProblem;
  } catch {
    return { code: `HTTP_${response.status}`, message: `Request failed with status ${response.status}`, diagnostics: [] };
  }
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

const documentUrl = (path: string) => `/api/v1/workspace/document?path=${encodeURIComponent(path)}`;

/** Stage 1 API (ADR 0010); paths and types come from `apps/server/openapi.json`. */
export const api = {
  health: () => request<HealthView>("/api/v1/health"),
  catalog: () => request<Catalog>("/api/v1/catalog"),
  documents: () => request<DocumentEntry[]>("/api/v1/workspace/documents"),
  document: (path: string) => request<DocumentView>(documentUrl(path)),
  /** Writes a document; [version] is the one it was read with, or null for a new document. */
  saveDocument: (path: string, content: DocumentContent, version: string | null) =>
    request<DocumentEntry>(documentUrl(path), json("PUT", content, version === null ? {} : { "If-Match": `"${version}"` })),
  validate: (experiment: string, drafts: DocumentDraft[] = []) =>
    request<ValidationView>("/api/v1/validate", json("POST", { experiment, drafts })),
  submitJob: (experiment: string) => request<JobView>("/api/v1/jobs", json("POST", { experiment })),
  job: (id: string) => request<JobView>(`/api/v1/jobs/${encodeURIComponent(id)}`),
  runSummary: (runId: string) => request<RunSummary>(`/api/v1/runs/${encodeURIComponent(runId)}/summary`),
};
