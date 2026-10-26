import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getJob,
  getResult,
  health,
  startExperiment,
  validateSubmission,
} from "./client";
import type { ExperimentSubmission } from "./types";

const submission = {
  experiment: {
    schemaVersion: 1,
    execution: {
      replications: 3,
      warmupMs: 100,
      measurementMs: 1_000,
      seed: 42,
      maxRealTimeSeconds: 30,
    },
    variants: [],
  },
  sweep: null,
} satisfies ExperimentSubmission;

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  it("requests backend health", async () => {
    const fetchMock = stubJson({
      status: "ok",
      applicationVersion: "0.1.0",
      kslVersion: "R1.8.1",
    });

    await expect(health()).resolves.toEqual({
      status: "ok",
      applicationVersion: "0.1.0",
      kslVersion: "R1.8.1",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/health", undefined);
  });

  it("posts a submission for validation", async () => {
    const fetchMock = stubJson({ valid: true, issues: [] });

    await expect(validateSubmission(submission)).resolves.toEqual({
      valid: true,
      issues: [],
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/scenarios/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
  });

  it("starts an experiment and parses its UUID and status", async () => {
    const fetchMock = stubJson({
      id: "7a81ce1c-5907-4a68-9767-f8f46ae38e3b",
      status: "QUEUED",
    });

    await expect(startExperiment(submission)).resolves.toEqual({
      id: "7a81ce1c-5907-4a68-9767-f8f46ae38e3b",
      status: "QUEUED",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/experiments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
    });
  });

  it("gets a job by UUID", async () => {
    const fetchMock = stubJson({
      id: "7a81ce1c-5907-4a68-9767-f8f46ae38e3b",
      status: "RUNNING",
    });

    await expect(getJob("7a81ce1c-5907-4a68-9767-f8f46ae38e3b")).resolves.toEqual({
      id: "7a81ce1c-5907-4a68-9767-f8f46ae38e3b",
      status: "RUNNING",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/experiments/7a81ce1c-5907-4a68-9767-f8f46ae38e3b",
      undefined,
    );
  });

  it("gets a completed experiment result", async () => {
    const result = {
      schemaVersion: 1,
      applicationVersion: "0.1.0",
      kslVersion: "R1.8.1",
      variants: [],
    };
    const fetchMock = stubJson(result);

    await expect(getResult("7a81ce1c-5907-4a68-9767-f8f46ae38e3b")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/experiments/7a81ce1c-5907-4a68-9767-f8f46ae38e3b/result",
      undefined,
    );
  });

  it("preserves structured validation issues on a 400 response", async () => {
    stubJson(
      {
        code: "INVALID_SUBMISSION",
        message: "Invalid experiment submission",
        issues: [{ path: "experiment.variants", message: "At least one variant is required" }],
      },
      false,
      400,
    );

    const error = await startExperiment(submission).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "INVALID_SUBMISSION",
      message: "Invalid experiment submission",
      issues: [{ path: "experiment.variants", message: "At least one variant is required" }],
    });
  });
});
