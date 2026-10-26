import { useCallback, useEffect, useRef, useState } from "react";
import { getJob, getResult, startExperiment } from "../api/client";
import type {
  ExperimentJob,
  ExperimentResult,
  ExperimentSubmission,
  JobStatus,
} from "../api/types";

interface ExperimentJobState {
  jobId: string | null;
  job: ExperimentJob | null;
  result: ExperimentResult | null;
  isRunning: boolean;
  error: string | null;
}

const idleState: ExperimentJobState = {
  jobId: null,
  job: null,
  result: null,
  isRunning: false,
  error: null,
};

function isActive(status: JobStatus): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Experiment request failed";
}

export function useExperimentJob() {
  const [state, setState] = useState<ExperimentJobState>(idleState);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(async (submission: ExperimentSubmission): Promise<void> => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () =>
      generationRef.current === generation && !controller.signal.aborted;
    const update = (change: (current: ExperimentJobState) => ExperimentJobState) => {
      if (isCurrent()) {
        setState((current) => (isCurrent() ? change(current) : current));
      }
    };
    const fail = (reason: unknown) => {
      update((current) => ({ ...current, isRunning: false, error: errorMessage(reason) }));
    };

    const loadResult = async (id: string): Promise<void> => {
      try {
        const value = await getResult(id, controller.signal);
        update((current) => ({ ...current, result: value, error: null }));
      } catch (reason: unknown) {
        fail(reason);
      }
    };

    const acceptJob = (job: ExperimentJob) => {
      update(() => ({
        jobId: job.id,
        job,
        result: null,
        isRunning: isActive(job.status),
        error: job.status === "FAILED" ? (job.error ?? "Experiment failed") : null,
      }));
      if (isActive(job.status)) {
        schedulePoll(job.id);
      } else if (job.status === "COMPLETED") {
        void loadResult(job.id);
      }
    };

    const poll = async (id: string): Promise<void> => {
      try {
        const job = await getJob(id, controller.signal);
        if (isCurrent()) {
          acceptJob(job);
        }
      } catch (reason: unknown) {
        fail(reason);
      }
    };

    function schedulePoll(id: string): void {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (isCurrent()) {
          void poll(id);
        }
      }, 500);
    }

    setState({ ...idleState, isRunning: true });
    try {
      const accepted = await startExperiment(submission, controller.signal);
      if (isCurrent()) {
        acceptJob({ id: accepted.id, status: accepted.status });
      }
    } catch (reason: unknown) {
      fail(reason);
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState(idleState);
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return {
    ...state,
    startComparison: start,
    startSweep: start,
    reset,
  };
}
