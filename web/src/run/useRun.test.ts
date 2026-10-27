import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, JobView } from "../api/apiTypes";
import { experimentPath, summary } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { useRun } from "./useRun";

afterEach(() => {
  vi.unstubAllGlobals();
});

const diagnostic: Diagnostic = {
  code: "PARAM_MISSING", severity: "ERROR", message: "Required parameter 'handlers' is missing",
};

function job(status: JobView["status"], extra: Partial<JobView> = {}): JobView {
  return {
    id: "job-1", experiment: experimentPath, runId: "run-1", status,
    completedTasks: status === "COMPLETED" ? 4 : 0, totalTasks: 4,
    error: null, diagnostics: [], ...extra,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function run() {
  const hook = renderHook(() => useRun(1));
  await act(async () => { await hook.result.current.run(experimentPath); });
  return hook.result;
}

describe("useRun", () => {
  it("submits the experiment, polls queued/running jobs and loads the summary", async () => {
    const statuses: JobView["status"][] = ["RUNNING", "COMPLETED"];
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("QUEUED") };
      if (url === "/api/v1/jobs/job-1") return { body: job(statuses.shift() ?? "COMPLETED") };
      if (url === "/api/v1/runs/run-1/summary") return { body: summary };
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await run();

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ experiment: experimentPath });
    expect(result.current.job?.status).toBe("COMPLETED");
    expect(result.current.summary).toEqual(summary);
    expect(result.current.experiment).toBe(experimentPath);
    expect(result.current.problem).toBeNull();
    expect(result.current.running).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs/job-1")).toHaveLength(2);
  });

  it("shows the diagnostics of a rejected experiment", async () => {
    stubFetch(() => ({ status: 400, body: { code: "EXPERIMENT_INVALID", message: "Experiment has errors", diagnostics: [diagnostic] } }));

    const result = await run();

    expect(result.current.problem).toEqual({ code: "EXPERIMENT_INVALID", message: "Experiment has errors", diagnostics: [diagnostic] });
    expect(result.current.running).toBe(false);
    expect(result.current.job).toBeNull();
  });

  it.each(["Experiment execution failed", null])("reports a failed job with error %s", async (error) => {
    const fetchMock = stubFetch(() => ({ status: 202, body: job("FAILED", { error, diagnostics: [diagnostic] }) }));

    const result = await run();

    expect(result.current.problem).toEqual({ code: "JOB_FAILED", message: error ?? "Job failed", diagnostics: [diagnostic] });
    expect(result.current.summary).toBeNull();
    expect(result.current.job?.status).toBe("FAILED");
    expect(result.current.running).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["poll", "summary"])("reports a network error during %s", async (stage) => {
    stubFetch((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: job(stage === "poll" ? "QUEUED" : "COMPLETED") };
      throw new Error("offline");
    });

    const result = await run();

    expect(result.current.problem).toEqual({ code: "CLIENT_ERROR", message: "offline", diagnostics: [] });
    expect(result.current.running).toBe(false);
    expect(result.current.summary).toBeNull();
  });

  it("clears completed results and failed-job state on reset", async () => {
    let fail = false;
    stubFetch((url) => url === "/api/v1/jobs"
      ? { status: 202, body: job(fail ? "FAILED" : "COMPLETED", { error: fail ? "boom" : null }) }
      : { body: summary });
    const result = await run();
    expect(result.current.summary).toEqual(summary);

    act(() => result.current.reset());
    expect(result.current.summary).toBeNull();
    fail = true;
    await act(async () => { await result.current.run(experimentPath); });
    expect(result.current.problem?.message).toBe("boom");
    act(() => result.current.reset());
    expect(result.current.job).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(result.current.experiment).toBeNull();
    expect(result.current.running).toBe(false);
  });

  it.each([
    ["poll", "reset"], ["summary", "reset"],
    ["poll", "newer run"], ["summary", "newer run"],
  ] as const)("ignores an in-flight %s response after %s", async (stage, action) => {
    const oldGate = deferred();
    const newGate = deferred();
    const reached = deferred();
    const newerPath = "retry-storm/newer.experiment.json";
    let submissions = 0;
    const fetchMock = stubFetch(async (url) => {
      if (url === "/api/v1/jobs") {
        if (++submissions === 1) return { status: 202, body: job(stage === "poll" ? "RUNNING" : "COMPLETED") };
        await newGate.promise;
        return { status: 202, body: job("FAILED", { id: "job-2", experiment: newerPath, error: "new failure" }) };
      }
      if (url === "/api/v1/jobs/job-1" || url === "/api/v1/runs/run-1/summary") {
        reached.release();
        await oldGate.promise;
        return { body: stage === "poll" ? job("COMPLETED") : summary };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let oldRun!: Promise<void>;
    act(() => { oldRun = result.current.run(experimentPath); });
    await act(async () => { await reached.promise; });
    expect(result.current.running).toBe(true);

    let newRun: Promise<void> = Promise.resolve();
    act(() => {
      if (action === "reset") result.current.reset();
      else newRun = result.current.run(newerPath);
    });
    oldGate.release();
    await act(async () => { await oldRun; });

    expect(result.current.job).toBeNull();
    expect(result.current.summary).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(result.current.experiment).toBe(action === "reset" ? null : newerPath);
    expect(result.current.running).toBe(action === "newer run");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/runs/run-1/summary")).toHaveLength(stage === "summary" ? 1 : 0);
    newGate.release();
    await act(async () => { await newRun; });
    if (action === "newer run") {
      expect(result.current.job?.id).toBe("job-2");
      expect(result.current.problem?.message).toBe("new failure");
      expect(result.current.running).toBe(false);
    }
  });

  it("clears previous results as soon as a newer submission starts", async () => {
    const gate = deferred();
    let submissions = 0;
    stubFetch(async (url) => {
      if (url !== "/api/v1/jobs") return { body: summary };
      if (++submissions > 1) await gate.promise;
      return { status: 202, body: job("COMPLETED") };
    });
    const result = await run();
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath); });
    expect(result.current.job).toBeNull();
    expect(result.current.summary).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(result.current.running).toBe(true);
    gate.release();
    await act(async () => { await pending; });
    await waitFor(() => expect(result.current.summary).toEqual(summary));
  });
});
