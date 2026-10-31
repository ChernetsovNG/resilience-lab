import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, JobView } from "../api/apiTypes";
import { experiment, experimentPath, manifest, model, modelPath, summary } from "../test/fixtures";
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
  it("reattaches an active resume after reload instead of submitting another one", async () => {
    const gate = deferred();
    let finished = false;
    let submissions = 0;
    stubFetch(async (url, init) => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [{ id: "run-1", experiment: experimentPath, directory: ".results/example/run-1", sizeBytes: 1, complete: false, completedAt: null }] };
      if (url === "/api/v1/jobs") return { body: [job("RUNNING", { id: "active-resume" })] };
      if (url === "/api/v1/jobs/active-resume") {
        await gate.promise;
        finished = true;
        return { body: job("COMPLETED", { id: "active-resume" }) };
      }
      if (init?.method === "POST") submissions += 1;
      return { body: url.endsWith("/summary") ? summary : { ...manifest, complete: finished } };
    });
    const { result } = renderHook(() => useRun(1));
    await act(async () => { await result.current.restore(experimentPath, model); });
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.canResume).toBe(false);
    expect(result.current.job?.id).toBe("active-resume");
    await act(async () => { gate.release(); });
    await waitFor(() => expect(result.current.summary).toEqual(summary));
    expect(submissions).toBe(0);
  });

  it.each([false, true])("retries a transient resume failure, reconciling ambiguous acceptance %s", async accepted => {
    let attempts = 0;
    let finished = false;
    stubFetch((url, init) => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [{ id: "run-1", experiment: experimentPath, directory: ".results/example/run-1", sizeBytes: 1, complete: false, completedAt: null }] };
      if (url === "/api/v1/jobs") return { body: accepted && attempts > 0 ? [job("COMPLETED", { id: "resumed" })] : [] };
      if (url === "/api/v1/runs/run-1/resume" && init?.method === "POST") {
        if (++attempts === 1) {
          finished = accepted;
          throw new Error("offline");
        }
        finished = true;
        return { status: 202, body: job("COMPLETED", { id: "resumed" }) };
      }
      return { body: url.endsWith("/summary") ? summary : { ...manifest, complete: finished } };
    });
    const { result } = renderHook(() => useRun(1));
    await act(async () => { await result.current.restore(experimentPath, model); });
    await act(async () => { await result.current.resume(); });
    expect(result.current.problem?.message).toBe("offline");
    expect(result.current.canResume).toBe(true);
    await act(async () => { await result.current.resume(); });
    expect(result.current.summary).toEqual(summary);
    expect(attempts).toBe(accepted ? 1 : 2);
    expect(result.current.canResume).toBe(false);
  });

  it.each(["completed summary", "incomplete snapshot", "incomplete identity"])("retains independently readable state when %s fails", async failure => {
    stubFetch(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [
        { id: "stored", experiment: experimentPath, directory: ".results/example/stored", sizeBytes: 1, complete: true, completedAt: 1000 },
        { id: "incomplete", experiment: experimentPath, directory: ".results/example/incomplete", sizeBytes: 1, complete: false, completedAt: null },
      ] };
      if (url === "/api/v1/jobs") return { body: [] };
      if (url === "/api/v1/runs/stored/summary") return failure === "completed summary"
        ? { status: 404, body: { code: "MISSING_SUMMARY", message: "Summary is missing", diagnostics: [] } } : { body: summary };
      if (url === "/api/v1/runs/incomplete/manifest") return { body: {
        ...manifest, complete: false, ...(failure === "incomplete snapshot" ? { snapshots: {} } : {}),
        ...(failure === "incomplete identity" ? { snapshots: { ...manifest.snapshots,
          [modelPath]: JSON.stringify({ ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: null } } }) } } : {}),
      } };
      return { body: manifest };
    });
    const { result } = renderHook(() => useRun(1));
    await act(async () => { await result.current.restore(experimentPath, model); });
    expect(result.current.problem).not.toBeNull();
    expect(result.current.summary).toEqual(failure === "completed summary" ? null : summary);
    expect(result.current.canResume).toBe(failure === "completed summary");
  });

  it("restores only this experiment's latest completion, even when run IDs have a different order", async () => {
    stubFetch(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [
        { id: "newer-start", experiment: experimentPath, complete: true, completedAt: 1000 },
        { id: "foreign", experiment: "other/retry-storm.experiment.json", complete: true, completedAt: 3000 },
        { id: "older-start", experiment: experimentPath, complete: true, completedAt: 2000 },
      ].map(run => ({ directory: `.results/example/${run.id}`, sizeBytes: 1, ...run })) };
      if (url === "/api/v1/runs/older-start/summary") return { body: summary };
      if (url === "/api/v1/runs/older-start/manifest") return { body: manifest };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    await act(async () => { await result.current.restore(experimentPath, model); });
    expect(result.current.result).toMatchObject({ runId: "older-start", summary, documents });
    expect(result.current.job).toBeNull();
    expect(result.current.experiment).toBe(experimentPath);
    expect(result.current.canResume).toBe(false);
    expect(result.current.problem).toBeNull();
  });

  it("restores incomplete run documents and resumes without an in-memory job", async () => {
    let resumed = false;
    stubFetch(url => {
      if (url === "/api/v1/jobs") return { body: [] };
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [{ id: "run-1", experiment: experimentPath, directory: ".results/example/run-1", sizeBytes: 1, complete: false, completedAt: null }] };
      if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: resumed } };
      if (url === "/api/v1/runs/run-1/resume") {
        resumed = true;
        return { status: 202, body: job("COMPLETED", { id: "resumed" }) };
      }
      if (url === "/api/v1/runs/run-1/summary") return { body: summary };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result } = renderHook(() => useRun(1));
    await act(async () => { await result.current.restore(experimentPath, model); });
    expect(result.current.result).toBeNull();
    expect(result.current.canResume).toBe(true);
    expect(result.current.documents).toEqual(documents);
    await act(async () => { await result.current.resume(); });
    expect(result.current.result).toMatchObject({ jobId: "resumed", documents });
    expect(result.current.canResume).toBe(false);
  });

  it.each(["reset", "new run"])("ignores delayed restored artifacts after %s", async action => {
    const gate = deferred();
    const reached = deferred();
    stubFetch(async url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [{ id: "stored", experiment: experimentPath, directory: ".results/example/stored", sizeBytes: 1, complete: true, completedAt: 1000 }] };
      if (url.includes("/runs/stored/")) {
        reached.release();
        await gate.promise;
      }
      if (url === "/api/v1/jobs") return { status: 202, body: job("COMPLETED") };
      return { body: url.endsWith("/summary") ? summary : manifest };
    });
    const { result } = renderHook(() => useRun(1));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.restore(experimentPath, model); });
    await act(async () => { await reached.promise; });
    await act(async () => {
      if (action === "reset") result.current.reset();
      else await result.current.run(experimentPath, documents);
    });
    await act(async () => { gate.release(); await pending; });
    expect(result.current.result?.runId ?? null).toBe(action === "reset" ? null : "run-1");
    expect(result.current.problem).toBeNull();
  });

  it("leaves results empty when there are no runs, and reports restoration failures", async () => {
    stubFetch(() => ({ body: [] }));
    const { result } = renderHook(() => useRun(1));
    await act(async () => { await result.current.restore(experimentPath, model); });
    expect(result.current.result).toBeNull();
    expect(result.current.canResume).toBe(false);
    stubFetch(() => { throw new Error("offline"); });
    await act(async () => { await result.current.restore(experimentPath, model); });
    expect(result.current.problem?.message).toBe("offline");
    expect(result.current.running).toBe(false);
  });

  it("retains a coherent completed snapshot until replacement artifacts arrive", async () => {
    const gate = deferred();
    let submissions = 0;
    const secondDocuments = { ...documents, experiment: { ...experiment, execution: { ...experiment.execution, seed: 42 } } };
    stubFetch(async url => {
      if (url === "/api/v1/jobs") return { status: 202, body: job("COMPLETED", ++submissions === 1 ? {} : { id: "job-2", runId: "run-2" }) };
      if (url.includes("/runs/run-2/")) await gate.promise;
      return { body: url.endsWith("/summary") ? summary : manifest };
    });
    const result = await run();
    const first = result.current.result;
    expect(first).toMatchObject({ runId: "run-1", jobId: "job-1", summary, manifest, documents });
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(experimentPath, secondDocuments); });
    await waitFor(() => expect(result.current.job?.id).toBe("job-2"));
    expect(result.current.result).toBe(first);
    await act(async () => { gate.release(); await pending; });
    expect(result.current.result).toMatchObject({ runId: "run-2", jobId: "job-2", documents: secondDocuments });
    act(() => result.current.reset());
    expect(result.current.result).toBeNull();
  });

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

  it("keeps previous results while a newer submission is pending", async () => {
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
    expect(result.current.summary).toEqual(summary);
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
    if (url === "/api/v1/jobs" && init?.method !== "POST") return { body: [] };
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
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/v1/jobs" && init?.method === "POST")).toHaveLength(1);
});

it("ignores a late resume acceptance after reset", async () => {
  const gate = deferred();
  const reached = deferred();
  stubFetch(async (url, init) => {
    if (url === "/api/v1/jobs" && init?.method !== "POST") return { body: [] };
    if (url === "/api/v1/jobs") return { status: 202, body: job("CANCELLED") };
    if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
    if (url === "/api/v1/runs/run-1/resume") {
      reached.release();
      await gate.promise;
      return { status: 202, body: job("COMPLETED", { id: "resume-1" }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const result = await run();
  let pending!: Promise<void>;
  act(() => { pending = result.current.resume(); });
  await act(async () => { await reached.promise; });
  act(() => result.current.reset());
  await act(async () => { gate.release(); await pending; });
  expect(result.current.job).toBeNull();
  expect(result.current.manifest).toBeNull();
  expect(result.current.summary).toBeNull();
  expect(result.current.problem).toBeNull();
  expect(result.current.running).toBe(false);
});

it("does not submit Resume if reset happens while reconciling retained jobs", async () => {
  const gate = deferred();
  const reached = deferred();
  let submissions = 0;
  stubFetch(async (url, init) => {
    if (url === "/api/v1/jobs" && init?.method !== "POST") {
      reached.release();
      await gate.promise;
      return { body: [] };
    }
    if (url === "/api/v1/jobs") return { status: 202, body: job("CANCELLED") };
    if (url === "/api/v1/runs/run-1/resume") submissions += 1;
    return { body: { ...manifest, complete: false } };
  });
  const result = await run();
  let pending!: Promise<void>;
  act(() => { pending = result.current.resume(); });
  await act(async () => { await reached.promise; });
  act(() => result.current.reset());
  await act(async () => { gate.release(); await pending; });
  expect(submissions).toBe(0);
  expect(result.current.job).toBeNull();
});
