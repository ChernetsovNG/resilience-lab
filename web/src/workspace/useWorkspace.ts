import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, Catalog, LayoutFile } from "../api/apiTypes";
import {
  dirtyDocuments, editorReducer, initialEditorState, setModelParam,
  type DocumentKind, type EditorCommand, type LoadedExperiment,
} from "./editor";
import { resolveRef } from "./paths";

export interface Workspace {
  catalog: Catalog | null;
  experiments: string[];
  loaded: LoadedExperiment | null;
  /** An experiment is being opened; editing, saving and running wait for it. */
  loading: boolean;
  dirty: boolean;
  dirtyDocuments: Record<DocumentKind, boolean>;
  saving: boolean;
  /** A stored document changed since it was read; only a reload continues. */
  conflict: boolean;
  conflictPath: string | null;
  problem: ApiProblem | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  execute: (command: EditorCommand) => void;
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

async function loadExperiment(experimentPath: string, recoveryLayoutPath?: string): Promise<LoadedExperiment> {
  const experimentView = await api.document(experimentPath);
  const experiment = experimentView.content.experiment;
  if (experiment == null) throw new Error(`${experimentPath} is not an experiment`);
  const modelPath = resolveRef(experimentPath, experiment.modelRef);
  if (modelPath === null) throw new Error(`modelRef of ${experimentPath} leaves the workspace`);
  const modelView = await api.document(modelPath);
  const model = modelView.content.model;
  if (model == null) throw new Error(`${modelPath} is not a model`);
  const layoutPath = experiment.layoutRef == null
    ? experimentPath.replace(/\.experiment\.json$/, ".layout.json")
    : resolveRef(experimentPath, experiment.layoutRef);
  if (layoutPath === null) throw new Error(`layoutRef of ${experimentPath} leaves the workspace`);
  let layout: LayoutFile = { schemaVersion: 1, positions: {} };
  let layoutVersion: string | null = null;
  // Recover a known or conflicting generated sibling on reload, without attaching its reference or overwriting it.
  if (experiment.layoutRef != null || recoveryLayoutPath === layoutPath) {
    try {
      const layoutView = await api.document(layoutPath);
      if (layoutView.content.layout == null) throw new Error(`${layoutPath} is not a layout`);
      layout = layoutView.content.layout;
      layoutVersion = layoutView.version;
    } catch (error) {
      if (!(experiment.layoutRef == null && error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  return {
    experimentPath, experiment, modelPath, model, layoutPath, layout,
    saved: { model, layout, experiment },
    versions: { model: modelView.version, layout: layoutVersion, experiment: experimentView.version },
  };
}

/** Loads workspace documents and saves command edits with the versions read from storage (stage 1 design §6.2). */
export function useWorkspace(): Workspace {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [experiments, setExperiments] = useState<string[]>([]);
  const [editor, dispatch] = useReducer(editorReducer, initialEditorState);
  const { loaded, conflictPath } = editor;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const generation = useRef(0);
  // A ref also blocks duplicate saves before React publishes the saving state.
  const saveInFlight = useRef(false);
  const loadInFlight = useRef(false);
  const changed = dirtyDocuments(loaded);
  const dirty = Object.values(changed).some(Boolean);
  const openedExperimentPath = loaded?.experimentPath;
  const recoveryLayoutPath = loaded !== null && (loaded.versions.layout !== null || conflictPath === loaded.layoutPath)
    ? loaded.layoutPath : undefined;

  const load = useCallback(async (experimentPath: string, recoveryLayoutPath?: string) => {
    const current = ++generation.current;
    loadInFlight.current = true;
    setLoading(true);
    setProblem(null);
    try {
      const next = await loadExperiment(experimentPath, recoveryLayoutPath);
      if (current === generation.current) dispatch({ type: "open", loaded: next });
    } catch (error) {
      if (current === generation.current) setProblem(problemOf(error));
    } finally {
      if (current === generation.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
  }, []);

  const open = useCallback(
    async (experimentPath: string, discardChanges = false) => {
      if (saveInFlight.current || (dirty && !discardChanges)) return false;
      await load(experimentPath, experimentPath === openedExperimentPath ? recoveryLayoutPath : undefined);
      return true;
    },
    [dirty, load, openedExperimentPath, recoveryLayoutPath],
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

  const execute = useCallback((command: EditorCommand) => {
    if (!loadInFlight.current) dispatch({ type: "command", command });
  }, []);
  const setParam = useCallback((id: string, name: string, value: unknown) => {
    execute(setModelParam(id, name, value));
  }, [execute]);
  const undo = useCallback(() => {
    if (!loadInFlight.current) dispatch({ type: "undo" });
  }, []);
  const redo = useCallback(() => {
    if (!loadInFlight.current) dispatch({ type: "redo" });
  }, []);

  const save = useCallback(async () => {
    if (loaded === null || !dirty || loadInFlight.current || conflictPath !== null || saveInFlight.current) return;
    const saved = loaded;
    const current = generation.current;
    saveInFlight.current = true;
    setSaving(true);
    setProblem(null);
    try {
      for (const kind of ["layout", "model", "experiment"] as const) {
        if (!dirtyDocuments(saved)[kind]) continue;
        const path = saved[`${kind}Path`];
        try {
          const entry = await api.saveDocument(path, { [kind]: saved[kind] }, saved.versions[kind]);
          if (current !== generation.current) return;
          dispatch({ type: "saved", kind, documents: saved, version: entry.version });
        } catch (error) {
          if (current !== generation.current) return;
          if (error instanceof ApiError && error.status === 409) dispatch({ type: "conflict", path });
          else setProblem(problemOf(error));
          break;
        }
      }
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [loaded, dirty, conflictPath]);

  const reload = useCallback(async () => {
    if (loaded !== null && !saveInFlight.current) await load(loaded.experimentPath, recoveryLayoutPath);
  }, [loaded, load, recoveryLayoutPath]);

  return {
    catalog, experiments, loaded, loading, dirty, dirtyDocuments: changed, saving,
    conflict: conflictPath !== null, conflictPath, problem, open, setParam, execute,
    canUndo: editor.past.length > 0, canRedo: editor.future.length > 0, undo, redo, save, reload,
  };
}
