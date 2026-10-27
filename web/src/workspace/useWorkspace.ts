import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, Catalog, ExperimentFile, LayoutFile, ModelFile } from "../api/apiTypes";
import { withParam } from "./params";
import { resolveRef } from "./paths";

/** An open experiment; model includes local edits and savedModel is its last stored snapshot. */
export interface LoadedExperiment {
  experimentPath: string;
  experiment: ExperimentFile;
  modelPath: string;
  model: ModelFile;
  savedModel: ModelFile;
  modelVersion: string;
  layout: LayoutFile | null;
}

export interface Workspace {
  catalog: Catalog | null;
  experiments: string[];
  loaded: LoadedExperiment | null;
  /** An experiment is being opened; editing, saving and running wait for it. */
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  /** The stored model changed since it was read; only a reload continues. */
  conflict: boolean;
  problem: ApiProblem | null;
  /** Opens a document unless saving or unsaved edits prevent it; discardChanges allows discarding edits. */
  open: (experimentPath: string, discardChanges?: boolean) => Promise<boolean>;
  setParam: (id: string, name: string, value: unknown) => void;
  save: () => Promise<void>;
  /** Rereads the open experiment from storage, discarding local edits. */
  reload: () => Promise<void>;
}

export function problemOf(error: unknown): ApiProblem {
  if (error instanceof ApiError) return error.problem;
  return { code: "CLIENT_ERROR", message: error instanceof Error ? error.message : "Request failed", diagnostics: [] };
}

async function loadExperiment(experimentPath: string): Promise<LoadedExperiment> {
  const experiment = (await api.document(experimentPath)).content.experiment;
  if (experiment == null) throw new Error(`${experimentPath} is not an experiment`);
  const modelPath = resolveRef(experimentPath, experiment.modelRef);
  if (modelPath === null) throw new Error(`modelRef of ${experimentPath} leaves the workspace`);
  const modelView = await api.document(modelPath);
  const model = modelView.content.model;
  if (model == null) throw new Error(`${modelPath} is not a model`);
  let layout: LayoutFile | null = null;
  if (experiment.layoutRef != null) {
    const layoutPath = resolveRef(experimentPath, experiment.layoutRef);
    if (layoutPath === null) throw new Error(`layoutRef of ${experimentPath} leaves the workspace`);
    layout = (await api.document(layoutPath)).content.layout ?? null;
    if (layout === null) throw new Error(`${layoutPath} is not a layout`);
  }
  return { experimentPath, experiment, modelPath, model, savedModel: model, modelVersion: modelView.version, layout };
}

/** Loads workspace documents and saves model edits with the version read from storage (stage 1 design §6.2). */
export function useWorkspace(): Workspace {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [experiments, setExperiments] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<LoadedExperiment | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const generation = useRef(0);
  // A ref also blocks duplicate saves before React publishes the saving state.
  const saveInFlight = useRef(false);
  const dirty = loaded !== null && loaded.model !== loaded.savedModel;

  const load = useCallback(async (experimentPath: string) => {
    const current = ++generation.current;
    setLoading(true);
    setProblem(null);
    setConflict(false);
    try {
      const next = await loadExperiment(experimentPath);
      if (current === generation.current) setLoaded(next);
    } catch (error) {
      if (current === generation.current) setProblem(problemOf(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  const open = useCallback(
    async (experimentPath: string, discardChanges = false) => {
      if (saveInFlight.current || (dirty && !discardChanges)) return false;
      await load(experimentPath);
      return true;
    },
    [dirty, load],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([api.catalog(), api.documents()])
      .then(async ([nextCatalog, documents]) => {
        if (!active) return;
        const paths = documents.filter((document) => document.kind === "EXPERIMENT").map((document) => document.path).sort();
        setCatalog(nextCatalog);
        setExperiments(paths);
        if (paths.length > 0) await load(paths[0]);
      })
      .catch((error: unknown) => {
        if (active) setProblem(problemOf(error));
      });
    return () => { active = false; };
  }, [load]);

  const setParam = useCallback((id: string, name: string, value: unknown) => {
    setLoaded((current) => current === null ? current : { ...current, model: withParam(current.model, id, name, value) });
  }, []);

  const save = useCallback(async () => {
    if (loaded === null || !dirty || loading || conflict || saveInFlight.current) return;
    const saved = loaded;
    const current = generation.current;
    saveInFlight.current = true;
    setSaving(true);
    setProblem(null);
    try {
      const entry = await api.saveDocument(saved.modelPath, { model: saved.model }, saved.modelVersion);
      if (current === generation.current) {
        setLoaded((now) => now === null ? now : { ...now, savedModel: saved.model, modelVersion: entry.version });
      }
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else setProblem(problemOf(error));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [loaded, dirty, loading, conflict]);

  const reload = useCallback(async () => {
    if (loaded !== null && !saveInFlight.current) await load(loaded.experimentPath);
  }, [loaded, load]);

  return { catalog, experiments, loaded, loading, dirty, saving, conflict, problem, open, setParam, save, reload };
}
