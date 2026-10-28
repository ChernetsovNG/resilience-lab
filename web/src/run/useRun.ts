import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/apiClient";
import type { ApiProblem, JobView, RunSummary } from "../api/apiTypes";
import { problemOf } from "../workspace/useWorkspace";

export interface Run {
  /** The experiment the state below belongs to. */
  experiment: string | null;
  job: JobView | null;
  summary: RunSummary | null;
  problem: ApiProblem | null;
  running: boolean;
  run: (experimentPath: string) => Promise<void>;
  reset: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Submits a job, polls every [pollMs] until it finishes and loads its summary (ADR 0010, item 4). */
export function useRun(pollMs = 500): Run {
  const [experiment, setExperiment] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [running, setRunning] = useState(false);
  const generation = useRef(0);

  useEffect(() => () => { generation.current += 1; }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    setExperiment(null);
    setJob(null);
    setSummary(null);
    setProblem(null);
    setRunning(false);
  }, []);

  const run = useCallback(async (experimentPath: string) => {
    const current = ++generation.current;
    const live = () => current === generation.current;
    setExperiment(experimentPath);
    setJob(null);
    setSummary(null);
    setProblem(null);
    setRunning(true);
    try {
      let next = await api.submitJob(experimentPath);
      while (next.status === "QUEUED" || next.status === "RUNNING") {
        if (!live()) return;
        setJob(next);
        await sleep(pollMs);
        if (!live()) return;
        next = await api.job(next.id);
      }
      if (!live()) return;
      setJob(next);
      if (next.status === "COMPLETED") {
        const loaded = await api.runSummary(next.runId);
        if (live()) setSummary(loaded);
      } else {
        setProblem({ code: "JOB_FAILED", message: next.error ?? "Job failed", diagnostics: next.diagnostics });
      }
    } catch (error) {
      if (live()) setProblem(problemOf(error));
    } finally {
      if (live()) setRunning(false);
    }
  }, [pollMs]);

  return { experiment, job, summary, problem, running, run, reset };
}
