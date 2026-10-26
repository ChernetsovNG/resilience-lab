import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getJob, getResult, startExperiment } from "../api/client";
import type { ExperimentJob, ExperimentResult, ExperimentSubmission } from "../api/types";
import { useExperimentJob } from "./useExperimentJob";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    startExperiment: vi.fn(),
    getJob: vi.fn(),
    getResult: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const submission: ExperimentSubmission = {
  experiment: {
    schemaVersion: 1,
    execution: {
      replications: 2,
      warmupMs: 100,
      measurementMs: 1_000,
      seed: 42,
      maxRealTimeSeconds: 30,
    },
    variants: [],
  },
  sweep: null,
};

function experimentResult(applicationVersion: string): ExperimentResult {
  return {
    schemaVersion: 1,
    applicationVersion,
    kslVersion: "R1.8.1",
    variants: [],
  };
}

const startMock = vi.mocked(startExperiment);
const getJobMock = vi.mocked(getJob);
const getResultMock = vi.mocked(getResult);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useExperimentJob", () => {
  it("accepts a 202 submission, polls every 500 ms, and fetches the result only after COMPLETED", async () => {
    const accepted = deferred<{ id: string; status: "QUEUED" }>();
    const running = deferred<ExperimentJob>();
    const completed = deferred<ExperimentJob>();
    const resultResponse = deferred<ExperimentResult>();
    startMock.mockReturnValueOnce(accepted.promise);
    getJobMock.mockReturnValueOnce(running.promise).mockReturnValueOnce(completed.promise);
    getResultMock.mockReturnValueOnce(resultResponse.promise);
    const { result } = renderHook(() => useExperimentJob());

    let starting!: Promise<void>;
    act(() => {
      starting = result.current.startComparison(submission);
    });
    expect(result.current.isRunning).toBe(true);
    expect(result.current.jobId).toBeNull();

    await act(async () => {
      accepted.resolve({ id: "job-1", status: "QUEUED" });
      await starting;
    });
    expect(result.current.jobId).toBe("job-1");
    expect(result.current.job?.status).toBe("QUEUED");
    expect(getResultMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(getJobMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getJobMock).toHaveBeenCalledWith("job-1", expect.any(AbortSignal));

    await act(async () => {
      running.resolve({ id: "job-1", status: "RUNNING" });
      await running.promise;
    });
    expect(result.current.job?.status).toBe("RUNNING");
    expect(result.current.isRunning).toBe(true);
    expect(getResultMock).not.toHaveBeenCalled();

    getJobMock.mockReturnValueOnce(completed.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      completed.resolve({ id: "job-1", status: "COMPLETED" });
      await completed.promise;
    });
    expect(result.current.job?.status).toBe("COMPLETED");
    expect(result.current.isRunning).toBe(false);
    expect(getResultMock).toHaveBeenCalledWith("job-1", expect.any(AbortSignal));
    expect(getResultMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resultResponse.resolve(experimentResult("1.0.0"));
      await resultResponse.promise;
    });
    expect(result.current.result?.applicationVersion).toBe("1.0.0");
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getJobMock).toHaveBeenCalledTimes(2);
  });

  it("ignores the first job result when a second job starts before it resolves", async () => {
    const firstAccepted = deferred<{ id: string; status: "QUEUED" }>();
    const secondAccepted = deferred<{ id: string; status: "QUEUED" }>();
    startMock.mockReturnValueOnce(firstAccepted.promise).mockReturnValueOnce(secondAccepted.promise);
    const { result } = renderHook(() => useExperimentJob());

    let firstStart!: Promise<void>;
    act(() => {
      firstStart = result.current.startComparison(submission);
    });
    await act(async () => {
      firstAccepted.resolve({ id: "job-old", status: "QUEUED" });
      await firstStart;
    });

    getJobMock.mockResolvedValueOnce({ id: "job-old", status: "COMPLETED" });
    const oldResult = deferred<ExperimentResult>();
    getResultMock.mockReturnValueOnce(oldResult.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getResultMock).toHaveBeenCalledWith("job-old", expect.any(AbortSignal));
    const firstSignal = startMock.mock.calls[0][1];

    let secondStart!: Promise<void>;
    act(() => {
      secondStart = result.current.startSweep(submission);
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.jobId).toBeNull();
    expect(result.current.result).toBeNull();

    await act(async () => {
      secondAccepted.resolve({ id: "job-new", status: "QUEUED" });
      await secondStart;
    });
    getJobMock.mockResolvedValueOnce({ id: "job-new", status: "COMPLETED" });
    getResultMock.mockResolvedValueOnce(experimentResult("new-result"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.jobId).toBe("job-new");
    expect(result.current.result?.applicationVersion).toBe("new-result");

    await act(async () => {
      oldResult.resolve(experimentResult("stale-result"));
      await oldResult.promise;
    });
    expect(result.current.jobId).toBe("job-new");
    expect(result.current.job?.id).toBe("job-new");
    expect(result.current.result?.applicationVersion).toBe("new-result");
  });

  it("stops polling on FAILED and exposes the backend failure", async () => {
    startMock.mockResolvedValueOnce({ id: "job-failed", status: "QUEUED" });
    getJobMock.mockResolvedValueOnce({
      id: "job-failed",
      status: "FAILED",
      error: "Simulation worker failed",
    });
    const { result } = renderHook(() => useExperimentJob());

    await act(async () => {
      await result.current.startComparison(submission);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.job?.status).toBe("FAILED");
    expect(result.current.error).toBe("Simulation worker failed");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.result).toBeNull();
    expect(getResultMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getJobMock).toHaveBeenCalledTimes(1);
  });

  it("does not request an unfinished result and surfaces a 409 if completion races the backend", async () => {
    startMock.mockResolvedValueOnce({ id: "job-conflict", status: "QUEUED" });
    getJobMock
      .mockResolvedValueOnce({ id: "job-conflict", status: "RUNNING" })
      .mockResolvedValueOnce({ id: "job-conflict", status: "COMPLETED" });
    getResultMock.mockRejectedValueOnce(
      new ApiError(409, "EXPERIMENT_NOT_COMPLETED", "Experiment result is not available", []),
    );
    const { result } = renderHook(() => useExperimentJob());

    await act(async () => {
      await result.current.startComparison(submission);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.job?.status).toBe("RUNNING");
    expect(getResultMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.error).toBe("Experiment result is not available");
    expect(result.current.result).toBeNull();
    expect(result.current.isRunning).toBe(false);
  });

  it("surfaces a 404 and stops the missing job lifecycle", async () => {
    startMock.mockResolvedValueOnce({ id: "job-missing", status: "QUEUED" });
    getJobMock.mockRejectedValueOnce(
      new ApiError(404, "EXPERIMENT_NOT_FOUND", "Experiment not found", []),
    );
    const { result } = renderHook(() => useExperimentJob());

    await act(async () => {
      await result.current.startComparison(submission);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.error).toBe("Experiment not found");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.result).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getJobMock).toHaveBeenCalledTimes(1);
  });

  it("aborts and ignores work on reset and unmount", async () => {
    const accepted = deferred<{ id: string; status: "QUEUED" }>();
    startMock.mockReturnValue(accepted.promise);
    const { result, unmount } = renderHook(() => useExperimentJob());

    act(() => {
      void result.current.startComparison(submission);
    });
    const resetSignal = startMock.mock.calls[0][1];
    act(() => result.current.reset());
    expect(resetSignal?.aborted).toBe(true);
    expect(result.current).toMatchObject({
      jobId: null,
      job: null,
      result: null,
      isRunning: false,
      error: null,
    });

    await act(async () => {
      accepted.resolve({ id: "stale-after-reset", status: "QUEUED" });
      await accepted.promise;
    });
    expect(result.current.jobId).toBeNull();

    const unmounted = deferred<{ id: string; status: "QUEUED" }>();
    startMock.mockReturnValueOnce(unmounted.promise);
    act(() => {
      void result.current.startComparison(submission);
    });
    const unmountSignal = startMock.mock.calls[1][1];
    unmount();
    expect(unmountSignal?.aborted).toBe(true);
    await act(async () => {
      unmounted.resolve({ id: "stale-after-unmount", status: "QUEUED" });
      await unmounted.promise;
    });
    expect(getJobMock).not.toHaveBeenCalled();
  });
});
