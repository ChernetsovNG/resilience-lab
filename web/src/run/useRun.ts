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
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Submits or resumes a job and loads its artifacts; terminal state is authoritative within each generation. */
export function useRun(pollMs = 500): Run {
  const [experiment, setExperiment] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [documents, setDocuments] = useState<RunDocuments | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [running, setRunning] = useState(false);
  const generation = useRef(0);
  const terminalGeneration = useRef<number | null>(null);

  const publishJob = useCallback((current: number, next: JobView) => {
    if (current !== generation.current || terminalGeneration.current === current) return;
    if (next.status !== "QUEUED" && next.status !== "RUNNING") terminalGeneration.current = current;
    setJob(next);
  }, []);

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

  const track = useCallback(async (submit: () => Promise<JobView>, resuming = false) => {
    const current = ++generation.current;
    const live = () => current === generation.current;
    setSummary(null);
    setProblem(null);
    setRunning(true);
    try {
      let next = await submit();
      while (next.status === "QUEUED" || next.status === "RUNNING") {
        if (!live()) return;
        publishJob(current, next);
        await sleep(pollMs);
        if (!live()) return;
        next = await api.job(next.id);
      }
      if (!live()) return;
      publishJob(current, next);
      setProblem(null);
      if (next.status === "COMPLETED") {
        const [loadedSummary, loadedManifest] = await Promise.all([api.runSummary(next.runId), api.runManifest(next.runId)]);
        if (live()) {
          setSummary(loadedSummary);
          setManifest(loadedManifest);
        }
      } else {
        if (next.status === "FAILED") {
          setProblem({ code: "JOB_FAILED", message: `${next.error ?? "Job failed"}${resuming ? " Start a new run with Run." : ""}`, diagnostics: next.diagnostics });
        }
        try {
          const loadedManifest = await api.runManifest(next.runId);
          if (live()) setManifest(loadedManifest);
        } catch (error) {
          // A queued cancellation or a preflight failure may create no artifact.
          if (live() && next.status === "CANCELLED" && !(error instanceof ApiError && error.status === 404)) {
            setProblem(problemOf(error));
          }
        }
      }
    } catch (error) {
      if (live()) {
        const failure = problemOf(error);
        const restart = resuming && error instanceof ApiError && (error.status === 400 || failure.code === "RUN_COMPLETE");
        setProblem({ ...failure, message: `${failure.message}${restart ? " Start a new run with Run." : ""}` });
      }
    } finally {
      if (live()) setRunning(false);
    }
  }, [pollMs, publishJob]);

  const run = useCallback(async (experimentPath: string, submitted: RunDocuments) => {
    setExperiment(experimentPath);
    setJob(null);
    setManifest(null);
    setDocuments(submitted);
    await track(() => api.submitJob(experimentPath));
  }, [track]);

  const resume = useCallback(async () => {
    if (job === null || manifest?.complete !== false || (job.status !== "CANCELLED" && job.status !== "FAILED")) return;
    await track(() => api.resumeRun(job.runId), true);
  }, [job, manifest, track]);

  const cancel = useCallback(async () => {
    if (job === null || (job.status !== "QUEUED" && job.status !== "RUNNING")) return;
    const current = generation.current;
    const live = () => current === generation.current;
    try {
      const next = await api.cancelJob(job.id);
      if (live()) publishJob(current, next);
    } catch (error) {
      if (!live() || terminalGeneration.current === current) return;
      if (error instanceof ApiError && error.status === 409 && error.problem.code === "JOB_FINISHED") {
        try {
          const next = await api.job(job.id);
          publishJob(current, next);
        } catch (refreshError) {
          if (live() && terminalGeneration.current !== current) setProblem(problemOf(refreshError));
        }
      } else if (terminalGeneration.current !== current) {
        setProblem(problemOf(error));
      }
    }
  }, [job, publishJob]);

  return { experiment, job, summary, manifest, documents, problem, running, run, resume, cancel, reset };
}
