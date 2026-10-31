import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, ExperimentFile, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { problemOf } from "../workspace/useWorkspace";
import { resolveRef } from "../workspace/paths";
import { documentValuesEqual, rememberElementCopies } from "../workspace/editor";

export interface RunDocuments {
  model: ModelFile;
  experiment: ExperimentFile;
}

/** Connection order is canonicalized in artifacts and does not change the modeled calls. */
export function runDocumentsEqual(left: RunDocuments, right: RunDocuments): boolean {
  const ordered = (model: ModelFile) => ({ ...model, connections: [...model.connections].sort((a, b) => a.id.localeCompare(b.id)) });
  return documentValuesEqual(left.experiment, right.experiment) && documentValuesEqual(ordered(left.model), ordered(right.model));
}

type RunProblem = ApiProblem & { requiresNewRun?: boolean };

/** One completed artifact and the exact documents submitted for it; independent of the next job. */
export interface RunResult {
  runId: string;
  jobId: string | null;
  summary: RunSummary;
  manifest: RunManifest;
  documents: RunDocuments;
}

export interface Run {
  /** The experiment the state below belongs to. */
  experiment: string | null;
  job: JobView | null;
  summary: RunSummary | null;
  manifest: RunManifest | null;
  documents: RunDocuments | null;
  result: RunResult | null;
  problem: RunProblem | null;
  running: boolean;
  canResume: boolean;
  restore: (experimentPath: string, currentModel: ModelFile) => Promise<boolean>;
  run: (experimentPath: string, documents: RunDocuments) => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function documentsOf(manifest: RunManifest, currentModel: ModelFile): RunDocuments {
  const experiment = JSON.parse(manifest.snapshots[manifest.experiment]) as ExperimentFile;
  const modelPath = resolveRef(manifest.experiment, experiment.modelRef);
  if (modelPath === null) throw new Error(t("app.workspace.requestFailed"));
  const model = JSON.parse(manifest.snapshots[modelPath]) as ModelFile;
  rememberElementCopies(currentModel, model);
  return { experiment, model };
}

/** Submits or resumes a job and loads its artifacts; terminal state is authoritative within each generation. */
export function useRun(pollMs = 500): Run {
  const [experiment, setExperiment] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [documents, setDocuments] = useState<RunDocuments | null>(null);
  const [problem, setProblem] = useState<RunProblem | null>(null);
  const [running, setRunning] = useState(false);
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
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
    setResult(null);
    setManifest(null);
    setDocuments(null);
    setProblem(null);
    setRunning(false);
    setResumeRunId(null);
  }, []);

  const track = useCallback(async (submit: (live: () => boolean) => Promise<JobView | null>, submitted: RunDocuments, resuming = false) => {
    const current = ++generation.current;
    const live = () => current === generation.current;
    setProblem(null);
    setRunning(true);
    if (!resuming) setResumeRunId(null);
    try {
      let next = await submit(live);
      if (next === null) return;
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
        setResumeRunId(null);
        const [loadedSummary, loadedManifest] = await Promise.all([api.runSummary(next.runId), api.runManifest(next.runId)]);
        if (live()) {
          setResult({ runId: next.runId, jobId: next.id, summary: loadedSummary, manifest: loadedManifest, documents: submitted });
          setManifest(loadedManifest);
        }
      } else {
        if (next.status === "FAILED") {
          setProblem({ code: next.errorCode ?? "JOB_FAILED", get message() { return next.error ?? t("app.run.failed"); },
            ...(next.errorArgs == null ? {} : { args: next.errorArgs }),
            ...(resuming ? { requiresNewRun: true } : {}), diagnostics: next.diagnostics });
        }
        try {
          const loadedManifest = await api.runManifest(next.runId);
          if (live()) {
            setManifest(loadedManifest);
            if (!loadedManifest.complete) setResumeRunId(next.runId);
          }
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
        setProblem({ ...failure, get message() { return failure.message; }, ...(restart ? { requiresNewRun: true } : {}) });
      }
    } finally {
      if (live()) setRunning(false);
    }
  }, [pollMs, publishJob]);

  /** Restores completed results and unfinished work independently of server job retention. */
  const restore = useCallback(async (experimentPath: string, currentModel: ModelFile) => {
    reset();
    const current = generation.current;
    const live = () => current === generation.current;
    setExperiment(experimentPath);
    try {
      const stored = (await api.latestRuns(experimentPath)).filter(entry => entry.experiment === experimentPath);
      if (!live()) return false;
      const completed = stored.filter(entry => entry.complete).sort((a, b) =>
        (b.completedAt ?? 0) - (a.completedAt ?? 0) || b.id.localeCompare(a.id) || a.directory.localeCompare(b.directory))[0];
      const incomplete = stored.find(entry => !entry.complete);
      const [completedRead, incompleteRead, jobsRead] = await Promise.allSettled([
        completed === undefined ? null : Promise.all([api.runManifest(completed.id), api.runSummary(completed.id)])
          .then(([manifest, summary]) => ({ runId: completed.id, jobId: null, manifest, summary, documents: documentsOf(manifest, currentModel) })),
        incomplete === undefined ? null : api.runManifest(incomplete.id)
          .then(manifest => ({ runId: incomplete.id, manifest, documents: documentsOf(manifest, currentModel) })),
        incomplete === undefined ? [] : api.jobs(),
      ]);
      if (!live()) return false;
      const finished = completedRead.status === "fulfilled" ? completedRead.value : null;
      const unfinished = incompleteRead.status === "fulfilled" ? incompleteRead.value : null;
      const existingJob = jobsRead.status === "fulfilled" && unfinished !== null ? jobsRead.value.find(job =>
        job.runId === unfinished.runId && job.experiment === experimentPath &&
        (job.status === "QUEUED" || job.status === "RUNNING" || job.status === "COMPLETED")) : undefined;
      const failure = [completedRead, incompleteRead, jobsRead].find(read => read.status === "rejected");
      setResult(finished);
      setManifest(unfinished?.manifest ?? finished?.manifest ?? null);
      setDocuments(unfinished?.documents ?? finished?.documents ?? null);
      setResumeRunId(unfinished !== null && !unfinished.manifest.complete && existingJob === undefined ? unfinished.runId : null);
      setProblem(failure === undefined ? null : problemOf(failure.reason));
      if (existingJob !== undefined && unfinished !== null) void track(() => Promise.resolve(existingJob), unfinished.documents, true);
      return finished !== null || unfinished !== null || failure !== undefined;
    } catch (error) {
      if (!live()) return false;
      setProblem(problemOf(error));
      return true;
    }
  }, [reset, track]);

  const run = useCallback(async (experimentPath: string, submitted: RunDocuments) => {
    if (experimentPath !== experiment) setResult(null);
    setExperiment(experimentPath);
    setJob(null);
    setManifest(null);
    setDocuments(submitted);
    await track(() => api.submitJob(experimentPath), submitted);
  }, [experiment, track]);

  const resume = useCallback(async () => {
    if (resumeRunId === null || documents === null || running) return;
    await track(async live => {
      const jobs = await api.jobs();
      if (!live()) return null;
      const existingJob = jobs.find(job => job.runId === resumeRunId && job.experiment === experiment &&
        (job.status === "QUEUED" || job.status === "RUNNING" || job.status === "COMPLETED"));
      return existingJob ?? api.resumeRun(resumeRunId);
    }, documents, true);
  }, [resumeRunId, documents, experiment, running, track]);

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

  return { experiment, job, summary: result?.summary ?? null, manifest, documents, result, problem, running,
    canResume: resumeRunId !== null && !running, restore, run, resume, cancel, reset };
}
