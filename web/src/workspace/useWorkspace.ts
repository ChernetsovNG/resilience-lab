import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { t } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { useLanguage } from "../i18n/useLanguage";
import { MessageError } from "../i18n/MessageError";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, Catalog, DocumentEntry, LayoutFile, WorkspaceChangeView } from "../api/apiTypes";
import {
  dirtyDocuments, editorReducer, initialEditorState, setModelParam,
  type DocumentKind, type EditorCommand, type LoadedExperiment,
} from "./editor";
import { resolveRef } from "./paths";

export interface ExternalDocumentChange {
  path: string;
  deleted: boolean;
}

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
  externalChange: ExternalDocumentChange | null;
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
  return { code: "CLIENT_ERROR", get message() { return error instanceof Error ? error.message : t("app.workspace.requestFailed"); }, diagnostics: [] };
}

async function loadExperiment(experimentPath: string, recoveryLayoutPath?: string): Promise<LoadedExperiment> {
  const experimentView = await api.document(experimentPath);
  const experiment = experimentView.content.experiment;
  if (experiment == null) throw new MessageError("app.workspace.notExperiment", { path: experimentPath });
  const modelPath = resolveRef(experimentPath, experiment.modelRef);
  if (modelPath === null) throw new MessageError("app.workspace.modelRefOutside", { path: experimentPath });
  const modelView = await api.document(modelPath);
  const model = modelView.content.model;
  if (model == null) throw new MessageError("app.workspace.notModel", { path: modelPath });
  const layoutPath = experiment.layoutRef == null
    ? experimentPath.replace(/\.experiment\.json$/, ".layout.json")
    : resolveRef(experimentPath, experiment.layoutRef);
  if (layoutPath === null) throw new MessageError("app.workspace.layoutRefOutside", { path: experimentPath });
  let layout: LayoutFile = { schemaVersion: 1, positions: {} };
  let layoutVersion: string | null = null;
  // Recover a known or conflicting generated sibling on reload, without attaching its reference or overwriting it.
  if (experiment.layoutRef != null || recoveryLayoutPath === layoutPath) {
    try {
      const layoutView = await api.document(layoutPath);
      if (layoutView.content.layout == null) throw new MessageError("app.workspace.notLayout", { path: layoutPath });
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

/** Loads workspace documents, tracks external changes and saves command edits with conditional versions (stage 1 design §6.2). */
export function useWorkspace(): Workspace {
  const language = useLanguage();
  const [sourceCatalog, setCatalog] = useState<Catalog | null>(null);
  const catalog = useMemo(() => sourceCatalog === null ? null : localizeCatalog(sourceCatalog, language), [sourceCatalog, language]);
  const [experiments, setExperiments] = useState<string[]>([]);
  const [editor, dispatch] = useReducer(editorReducer, initialEditorState);
  const { loaded, conflictPath } = editor;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [externalChanges, setExternalChanges] = useState<Readonly<Record<string, ExternalDocumentChange>>>({});
  const generation = useRef(0);
  // A ref also blocks duplicate saves before React publishes the saving state.
  const saveInFlight = useRef(false);
  const loadInFlight = useRef(false);
  const loadedRef = useRef<LoadedExperiment | null>(null);
  const savingPaths = useRef(new Set<string>());
  const deferredChanges = useRef(new Map<string, WorkspaceChangeView>());
  const cursor = useRef<string | null>(null);
  const persistenceRevision = useRef(0);
  const changed = dirtyDocuments(loaded);
  const dirty = Object.values(changed).some(Boolean);
  const openedExperimentPath = loaded?.experimentPath;
  const externalList = Object.values(externalChanges);
  const externalChange = externalList.find((change) => change.deleted) ?? externalList[0] ?? null;
  const recoveryLayoutPath = loaded !== null && (
    loaded.versions.layout !== null || conflictPath === loaded.layoutPath || externalChanges[loaded.layoutPath] !== undefined
  ) ? loaded.layoutPath : undefined;

  const classifyChanges = useCallback((changes: readonly WorkspaceChangeView[]) => {
    const current = loadedRef.current;
    if (current === null) return;
    const latest = new Map<string, WorkspaceChangeView>();
    for (const change of changes) latest.set(change.path, change);
    for (const change of latest.values()) {
      const path = change.path;
      const kind = (["model", "layout", "experiment"] as const).find((candidate) => current[`${candidate}Path`] === path);
      if (kind === undefined) continue;
      const version = change.version ?? null;
      if (savingPaths.current.has(path)) {
        deferredChanges.current.set(path, change);
        continue;
      }
      setExternalChanges((previous) => {
        if (version === current.versions[kind]) {
          if (previous[path] === undefined) return previous;
          const next = { ...previous };
          delete next[path];
          return next;
        }
        const deleted = version === null;
        if (previous[path]?.deleted === deleted) return previous;
        return { ...previous, [path]: { path, deleted } };
      });
    }
  }, []);

  const flushChange = useCallback((path: string) => {
    savingPaths.current.delete(path);
    const change = deferredChanges.current.get(path);
    if (change === undefined) return;
    deferredChanges.current.delete(path);
    classifyChanges([change]);
  }, [classifyChanges]);

  const load = useCallback(async (experimentPath: string, recoveryLayoutPath?: string) => {
    const current = ++generation.current;
    loadInFlight.current = true;
    setLoading(true);
    setProblem(null);
    try {
      const next = await loadExperiment(experimentPath, recoveryLayoutPath);
      if (current === generation.current) {
        persistenceRevision.current += 1;
        loadedRef.current = next;
        deferredChanges.current.clear();
        setExternalChanges({});
        dispatch({ type: "open", loaded: next });
      }
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshDocuments = async (): Promise<DocumentEntry[] | null> => {
      const documents = await api.documents();
      if (!active) return null;
      setExperiments(documents.filter((document) => document.kind === "EXPERIMENT").map((document) => document.path).sort());
      return documents;
    };
    const poll = async (): Promise<void> => {
      try {
        if (loadInFlight.current) return;
        const revision = persistenceRevision.current;
        const since = cursor.current;
        const response = await api.changes(since ?? undefined);
        if (!active) return;
        let changes = response.changes;
        if (since === null || response.reset) {
          const documents = await refreshDocuments();
          if (documents === null) return;
          const current = loadedRef.current;
          const versions = new Map(documents.map((document) => [document.path, document.version]));
          changes = current === null ? [] : (["model", "layout", "experiment"] as const).map((kind) => {
            const path = current[`${kind}Path`];
            return {
              path,
              kind: kind === "model" ? "MODEL" : kind === "layout" ? "LAYOUT" : "EXPERIMENT",
              version: versions.get(path) ?? null,
            };
          });
        } else if (response.changes.some((change) => change.kind === "EXPERIMENT")) {
          if (await refreshDocuments() === null) return;
        }
        // A response consumed against a newer open/save snapshot would be classified against the wrong versions.
        if (loadInFlight.current || revision !== persistenceRevision.current) return;
        classifyChanges(changes);
        cursor.current = response.cursor;
      } catch {
        // A failed poll keeps both the cursor and editor state untouched; the next attempt retries it.
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000);
      }
    };
    const initialize = async (): Promise<void> => {
      try {
        const initial = await api.changes();
        if (active) cursor.current = initial.cursor;
      } catch {
        // The first successful poll reconciles a workspace loaded without an initial cursor.
      }
      if (!active) return;
      try {
        const [nextCatalog, documents] = await Promise.all([api.catalog(), api.documents()]);
        if (!active) return;
        const paths = documents.filter((document) => document.kind === "EXPERIMENT").map((document) => document.path).sort();
        setCatalog(nextCatalog);
        setExperiments(paths);
        if (paths.length > 0) await load(paths[0]);
      } catch (error) {
        if (active) setProblem(problemOf(error));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void initialize();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load, classifyChanges]);

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
        savingPaths.current.add(path);
        try {
          const entry = await api.saveDocument(path, { [kind]: saved[kind] }, saved.versions[kind]);
          if (current !== generation.current) return;
          persistenceRevision.current += 1;
          const latest = loadedRef.current;
          if (latest !== null) {
            loadedRef.current = {
              ...latest,
              saved: { ...latest.saved, [kind]: saved[kind] },
              versions: { ...latest.versions, [kind]: entry.version },
            };
          }
          dispatch({ type: "saved", kind, documents: saved, version: entry.version });
        } catch (error) {
          if (current !== generation.current) return;
          if (error instanceof ApiError && error.status === 409) dispatch({ type: "conflict", path });
          else setProblem(problemOf(error));
          break;
        } finally {
          flushChange(path);
        }
      }
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [loaded, dirty, conflictPath, flushChange]);

  const reload = useCallback(async () => {
    if (loaded !== null && !saveInFlight.current && externalChange?.deleted !== true) {
      await load(loaded.experimentPath, recoveryLayoutPath);
    }
  }, [loaded, load, recoveryLayoutPath, externalChange]);

  return {
    catalog, experiments, loaded, loading, dirty, dirtyDocuments: changed, saving,
    conflict: conflictPath !== null, conflictPath, externalChange, problem, open, setParam, execute,
    canUndo: editor.past.length > 0, canRedo: editor.future.length > 0, undo, redo, save, reload,
  };
}
