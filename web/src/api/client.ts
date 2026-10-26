import type {
  ExperimentJob,
  ExperimentResult,
  ExperimentSubmission,
  HealthView,
  JobStatus,
  ValidationIssue,
  ValidationReport,
} from "./types";

interface ApiErrorBody {
  code: string;
  message: string;
  issues: ValidationIssue[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(status: number, code: string, message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const error = (await response.json()) as ApiErrorBody;
    throw new ApiError(response.status, error.code, error.message, error.issues);
  }
  return (await response.json()) as T;
}

export function health(): Promise<HealthView> {
  return request<HealthView>("/api/v1/health");
}

export function validateSubmission(value: ExperimentSubmission): Promise<ValidationReport> {
  return request<ValidationReport>("/api/v1/scenarios/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

export function startExperiment(
  value: ExperimentSubmission,
): Promise<{ id: string; status: JobStatus }> {
  return request<{ id: string; status: JobStatus }>("/api/v1/experiments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

export function getJob(id: string): Promise<ExperimentJob> {
  return request<ExperimentJob>(`/api/v1/experiments/${encodeURIComponent(id)}`);
}

export function getResult(id: string): Promise<ExperimentResult> {
  return request<ExperimentResult>(`/api/v1/experiments/${encodeURIComponent(id)}/result`);
}
