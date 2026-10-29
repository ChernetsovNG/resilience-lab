import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, JobView } from "../api/apiTypes";
import { experiment, experimentPath, manifest, model, summary } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import { useRun } from "./useRun";

afterEach(() => {
  vi.unstubAllGlobals();
});

const diagnostic: Diagnostic = {
  code: "PARAM_MISSING", severity: "ERROR", message: "Required parameter 'handlers' is missing",
};
const documents = { model, experiment };

function job(status: JobView["status"], extra: Partial<JobView> = {}): JobView {
  return {
    id: "job-1", experiment: experimentPath, runId: "run-1", status,
    completedTasks: status === "COMPLETED" ? 4 : 0, totalTasks: 4,
    cancelRequested: false, error: null, diagnostics: [], ...extra,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function run() {
  const hook = renderHook(() => useRun(1));
  await act(async () => { await hook.result.current.run(experimentPath, documents); });
  return hook.result;
}

describe("useRun", () => {
  it("submits the experiment, polls queued/running jobs and loads run artifacts", async () => {
    const statuses: JobView["status"][] = ["RUNNING", "COMPLETED"];
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("QUEUED") };
      if (url === "/api/v1/jobs/job-1") return { body: job(statuses.shift() ?? "COMPLETED") };
      if (url === "/api/v1/runs/run-1/summary") return { body: summary };
      if (url === "/api/v1/runs/run-1/manifest") return { body: manifest };
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await run();

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ experiment: experimentPath });
    expect(result.current.job?.status).toBe("COMPLETED");
    expect(result.current.summary).toEqual(summary);
    expect(result.current.manifest).toEqual(manifest);
    expect(result.current.documents).toEqual(documents);
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
    const fetchMock = stubFetch((url) => url === "/api/v1/jobs"
      ? { status: 202, body: job("FAILED", { error, diagnostics: [diagnostic] }) }
      : { status: 404, body: { code: "RUN_NOT_FOUND", message: "No artifact", diagnostics: [] } });

    const result = await run();

    expect(result.current.problem).toEqual({ code: "JOB_FAILED", message: error ?? "Job failed", diagnostics: [diagnostic] });
    expect(result.current.summary).toBeNull();
    expect(result.current.job?.status).toBe("FAILED");
    expect(result.current.running).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/summary"))).toBe(false);
  });

  it("retains a job failure code and scalar arguments for localization at display time", async () => {
    stubFetch(url => url === "/api/v1/jobs"
      ? { status: 202, body: job("FAILED", { error: "Job queue is full", errorCode: "JOB_QUEUE_FULL", errorArgs: {} }) }
      : { status: 404, body: { code: "RUN_NOT_FOUND", message: "No artifact", diagnostics: [] } });
    const result = await run();
    expect(result.current.problem).toMatchObject({ code: "JOB_QUEUE_FULL", args: {}, message: "Job queue is full" });
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
      : { body: url.includes("/summary") ? summary : manifest });
    const result = await run();
    expect(result.current.summary).toEqual(summary);

    act(() => result.current.reset());
    expect(result.current.summary).toBeNull();
    expect(result.current.manifest).toBeNull();
    expect(result.current.documents).toBeNull();
    fail = true;
    await act(async () => { await result.current.run(experimentPath, documents); });
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
      if (url === "/api/v1/jobs/job-1" || url === "/api/v1/runs/run-1/summary" || url === "/api/v1/runs/run-1/manifest") {
        reached.release();
        await oldGate.promise;
        return { body: stage === "poll" ? job("COMPLETED") : url.includes("/summary") ? summary : manifest };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let oldRun!: Promise<void>;
    act(() => { oldRun = result.current.run(experimentPath, documents); });
    await act(async () => { await reached.promise; });
    expect(result.current.running).toBe(true);

    let newRun: Promise<void> = Promise.resolve();
    act(() => {
      if (action === "reset") result.current.reset();
      else newRun = result.current.run(newerPath, documents);
    });
    oldGate.release();
    await act(async () => { await oldRun; });

    expect(result.current.job).toBeNull();
    expect(result.current.summary).toBeNull();
    expect(result.current.manifest).toBeNull();
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
      if (url !== "/api/v1/jobs") return { body: url.includes("/summary") ? summary : manifest };
      if (++submissions > 1) await gate.promise;
      return { status: 202, body: job("COMPLETED") };
    });
    const result = await run();
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, documents); });
    expect(result.current.job).toBeNull();
    expect(result.current.summary).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(result.current.running).toBe(true);
    gate.release();
    await act(async () => { await pending; });
    await waitFor(() => expect(result.current.summary).toEqual(summary));
  });

  it("cancels an active job without reporting a failure", async () => {
    let cancelRequested = false;
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("RUNNING") };
      if (url === "/api/v1/jobs/job-1/cancel" && init?.method === "POST") {
        cancelRequested = true;
        return { status: 202, body: job("RUNNING", { cancelRequested: true }) };
      }
      if (url === "/api/v1/jobs/job-1") {
        return { body: job(cancelRequested ? "CANCELLED" : "RUNNING", { cancelRequested }) };
      }
      if (url === "/api/v1/runs/run-1/manifest") return { status: 404, body: { code: "RUN_NOT_FOUND", message: "No artifact", diagnostics: [] } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, documents); });
    await waitFor(() => expect(result.current.job?.status).toBe("RUNNING"));

    await act(async () => { await result.current.cancel(); });
    expect(result.current.job?.cancelRequested).toBe(true);
    await act(async () => { await pending; });

    expect(result.current.job?.status).toBe("CANCELLED");
    expect(result.current.problem).toBeNull();
    expect(result.current.running).toBe(false);
    expect(result.current.summary).toBeNull();
    expect(result.current.manifest).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(1);
  });

  it("treats JOB_FINISHED as a race and loads the completed result", async () => {
    let finished = false;
    stubFetch((url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("RUNNING") };
      if (url === "/api/v1/jobs/job-1/cancel" && init?.method === "POST") {
        finished = true;
        return { status: 409, body: { code: "JOB_FINISHED", message: "Job already finished", diagnostics: [] } };
      }
      if (url === "/api/v1/jobs/job-1") return { body: job(finished ? "COMPLETED" : "RUNNING") };
      if (url === "/api/v1/runs/run-1/summary") return { body: summary };
      if (url === "/api/v1/runs/run-1/manifest") return { body: manifest };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, documents); });
    await waitFor(() => expect(result.current.job?.status).toBe("RUNNING"));

    await act(async () => { await result.current.cancel(); });
    expect(result.current.job?.status).toBe("COMPLETED");
    expect(result.current.problem).toBeNull();
    await act(async () => { await pending; });
    expect(result.current.summary).toEqual(summary);
    expect(result.current.manifest).toEqual(manifest);
  });

  it("keeps the terminal job when a delayed cancellation response arrives after the terminal poll", async () => {
    const response = deferred();
    let requested = false;
    stubFetch(async (url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("RUNNING") };
      if (url === "/api/v1/jobs/job-1/cancel" && init?.method === "POST") {
        requested = true;
        await response.promise;
        return { status: 202, body: job("RUNNING", { cancelRequested: true }) };
      }
      if (url === "/api/v1/jobs/job-1") return { body: job(requested ? "CANCELLED" : "RUNNING", { cancelRequested: requested }) };
      if (url === "/api/v1/runs/run-1/manifest") return { status: 404, body: { code: "RUN_NOT_FOUND", message: "No artifact", diagnostics: [] } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, documents); });
    await waitFor(() => expect(result.current.job?.status).toBe("RUNNING"));
    let cancelling!: Promise<void>;
    act(() => { cancelling = result.current.cancel(); });

    await act(async () => { await pending; });
    expect(result.current.job?.status).toBe("CANCELLED");
    expect(result.current.running).toBe(false);
    response.release();
    await act(async () => { await cancelling; });
    expect(result.current.job?.status).toBe("CANCELLED");
    expect(result.current.running).toBe(false);
    expect(result.current.problem).toBeNull();
  });

  it("ignores a delayed cancellation error after completed artifacts load", async () => {
    const failure = deferred();
    let finished = false;
    stubFetch(async (url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("RUNNING") };
      if (url === "/api/v1/jobs/job-1/cancel" && init?.method === "POST") {
        finished = true;
        await failure.promise;
        return { status: 500, body: { code: "CANCEL_FAILED", message: "Cancel failed", diagnostics: [] } };
      }
      if (url === "/api/v1/jobs/job-1") return { body: job(finished ? "COMPLETED" : "RUNNING") };
      if (url === "/api/v1/runs/run-1/summary") return { body: summary };
      if (url === "/api/v1/runs/run-1/manifest") return { body: manifest };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, documents); });
    await waitFor(() => expect(result.current.job?.status).toBe("RUNNING"));
    let cancelling!: Promise<void>;
    act(() => { cancelling = result.current.cancel(); });

    await act(async () => { await pending; });
    expect(result.current.summary).toEqual(summary);
    expect(result.current.manifest).toEqual(manifest);
    failure.release();
    await act(async () => { await cancelling; });
    expect(result.current.job?.status).toBe("COMPLETED");
    expect(result.current.problem).toBeNull();
    expect(result.current.summary).toEqual(summary);
    expect(result.current.manifest).toEqual(manifest);
  });

  it("ignores a late cancellation response after reset", async () => {
    const gate = deferred();
    let cancelCalls = 0;
    stubFetch(async (url, init) => {
      if (url === "/api/v1/jobs" && init?.method === "POST") return { status: 202, body: job("RUNNING") };
      if (url === "/api/v1/jobs/job-1/cancel" && init?.method === "POST") {
        cancelCalls += 1;
        await gate.promise;
        return { status: 202, body: job("RUNNING", { cancelRequested: true }) };
      }
      if (url === "/api/v1/jobs/job-1") return { body: job("RUNNING") };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, documents); });
    await waitFor(() => expect(result.current.job?.status).toBe("RUNNING"));
    let cancelling!: Promise<void>;
    act(() => { cancelling = result.current.cancel(); });
    await waitFor(() => expect(cancelCalls).toBe(1));

    act(() => result.current.reset());
    gate.release();
    await act(async () => { await cancelling; await pending; });
    expect(result.current.job).toBeNull();
    expect(result.current.problem).toBeNull();
    expect(result.current.running).toBe(false);
  });
});


it("cancels a resumed job using its new job ID and keeps the original run documents", async () => {
  let cancelled = false;
  const fetchMock = stubFetch((url, init) => {
    if (url === "/api/v1/jobs") return { status: 202, body: job("CANCELLED") };
    if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
    if (url === "/api/v1/runs/run-1/resume" && init?.method === "POST") return { status: 202, body: job("RUNNING", { id: "resume-1" }) };
    if (url === "/api/v1/jobs/resume-1/cancel" && init?.method === "POST") {
      cancelled = true;
      return { status: 202, body: job("RUNNING", { id: "resume-1", cancelRequested: true }) };
    }
    if (url === "/api/v1/jobs/resume-1") return { body: job(cancelled ? "CANCELLED" : "RUNNING", { id: "resume-1", cancelRequested: cancelled }) };
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await run();
  expect(result.current.manifest?.complete).toBe(false);
  let pending!: Promise<void>;
  act(() => { pending = result.current.resume(); });
  await waitFor(() => expect(result.current.job?.id).toBe("resume-1"));
  await act(async () => { await result.current.cancel(); await pending; });
  expect(result.current.job?.status).toBe("CANCELLED");
  expect(result.current.manifest?.complete).toBe(false);
  expect(result.current.summary).toBeNull();
  expect(result.current.problem).toBeNull();
  expect(result.current.documents).toEqual(documents);
  expect(result.current.experiment).toBe(experimentPath);
  expect(result.current.running).toBe(false);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs")).toHaveLength(1);
});

it("ignores a late resume acceptance after reset", async () => {
  const gate = deferred();
  stubFetch(async (url) => {
    if (url === "/api/v1/jobs") return { status: 202, body: job("CANCELLED") };
    if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
    if (url === "/api/v1/runs/run-1/resume") {
      await gate.promise;
      return { status: 202, body: job("COMPLETED", { id: "resume-1" }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await run();
  let pending!: Promise<void>;
  act(() => { pending = result.current.resume(); });
  act(() => result.current.reset());
  await act(async () => { gate.release(); await pending; });
  expect(result.current.job).toBeNull();
  expect(result.current.manifest).toBeNull();
  expect(result.current.summary).toBeNull();
  expect(result.current.problem).toBeNull();
  expect(result.current.running).toBe(false);
});
