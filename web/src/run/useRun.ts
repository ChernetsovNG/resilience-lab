import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, ExperimentFile, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { problemOf } from "../workspace/useWorkspace";

export interface RunDocuments {
  model: ModelFile;
  experiment: ExperimentFile;
}

export interface Run {
  /** The experiment the state below belongs to. */
  experiment: string | null;
  job: JobView | null;
  summary: RunSummary | null;
  manifest: RunManifest | null;
  documents: RunDocuments | null;
  problem: ApiProblem | null;
  running: boolean;
  run: (experimentPath: string, documents: RunDocuments) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Submits and polls a job, then loads its summary and manifest; cancellation shares the same generation guard. */
export function useRun(pollMs = 500): Run {
  const [experiment, setExperiment] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [documents, setDocuments] = useState<RunDocuments | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [running, setRunning] = useState(false);
  const generation = useRef(0);

  useEffect(() => () => { generation.current += 1; }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    setExperiment(null);
    setJob(null);
    setSummary(null);
    setManifest(null);
    setDocuments(null);
    setProblem(null);
    setRunning(false);
  }, []);

  const run = useCallback(async (experimentPath: string, submitted: RunDocuments) => {
    const current = ++generation.current;
    const live = () => current === generation.current;
    setExperiment(experimentPath);
    setJob(null);
    setSummary(null);
    setManifest(null);
    setDocuments(submitted);
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
        const [loadedSummary, loadedManifest] = await Promise.all([api.runSummary(next.runId), api.runManifest(next.runId)]);
        if (live()) {
          setSummary(loadedSummary);
          setManifest(loadedManifest);
        }
      } else if (next.status !== "CANCELLED") {
        setProblem({ code: "JOB_FAILED", message: next.error ?? "Job failed", diagnostics: next.diagnostics });
      }
    } catch (error) {
      if (live()) setProblem(problemOf(error));
    } finally {
      if (live()) setRunning(false);
    }
  }, [pollMs]);

  const cancel = useCallback(async () => {
    if (job === null || (job.status !== "QUEUED" && job.status !== "RUNNING")) return;
    const current = generation.current;
    const live = () => current === generation.current;
    try {
      const next = await api.cancelJob(job.id);
      if (live()) setJob(next);
    } catch (error) {
      if (!live()) return;
      if (error instanceof ApiError && error.status === 409 && error.problem.code === "JOB_FINISHED") {
        try {
          const next = await api.job(job.id);
          if (live()) setJob(next);
        } catch (refreshError) {
          if (live()) setProblem(problemOf(refreshError));
        }
      } else {
        setProblem(problemOf(error));
      }
    }
  }, [job]);

  return { experiment, job, summary, manifest, documents, problem, running, run, cancel, reset };
}
