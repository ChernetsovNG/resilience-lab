import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { t } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { useLanguage } from "../i18n/useLanguage";
import { MessageError } from "../i18n/MessageError";
import { ApiError, api } from "../api/apiClient";
import type { ApiProblem, Catalog, DocumentEntry, DocumentDraft, LayoutFile, RunStorageEntry, WorkspaceChangeView } from "../api/apiTypes";
import {
  dirtyDocuments, editorReducer, initialEditorState, setModelParam,
  type DocumentKind, type EditorCommand, type LoadedExperiment,
} from "./editor";
import { resolveRef } from "./paths";
import { checkDeletionReferences, defaultExperiment, documentsToDelete, exportDocuments, runsToDelete, writeDocuments, type ConfirmReplace, type DownloadDocument } from "./fileActions";
import { experimentsForModel, preferredExperiment, preferredModel, readSelection, rememberSelection } from "./modelSelection";

export interface ExternalDocumentChange {
  path: string;
  deleted: boolean;
}

export interface Workspace {
  catalog: Catalog | null;
  models: string[];
  /** Model selection survives a failed question load so another question remains accessible. */
  selectedModel: string | null;
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
  /** Opens the model's remembered question, or an in-memory default until the first Save or Run. */
  openModel: (modelPath: string, discardChanges?: boolean) => Promise<boolean>;
  setParam: (id: string, name: string, value: unknown) => void;
  save: () => Promise<boolean>;
  /** Writes a checked file action, refreshes the picker and opens the imported or created experiment. */
  storeDocuments: (drafts: DocumentDraft[], confirmReplace?: ConfirmReplace, validate?: boolean) => Promise<boolean>;
  /** Deletes a confirmed snapshot in order, stops at the first failure and reconciles the open documents. */
  removeDocuments: (plan: DocumentEntry[], discardChanges?: boolean, runs?: RunStorageEntry[]) => Promise<boolean>;
  /** Downloads saved canonical documents; a failed save never starts an export. */
  exportFiles: (saveFirst?: boolean) => Promise<DownloadDocument[] | null>;
  reportProblem: (error: unknown) => void;
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

async function loadModel(modelPath: string, documents: readonly DocumentEntry[]): Promise<LoadedExperiment> {
  const view = await api.document(modelPath);
  const model = view.content.model;
  if (model == null) throw new MessageError("app.workspace.notModel", { path: modelPath });
  const layoutPath = modelPath.replace(/\.model\.json$/, ".layout.json");
  const layoutView = documents.some(document => document.path === layoutPath) ? await api.document(layoutPath) : null;
  const layout = layoutView?.content.layout ?? { schemaVersion: 1, positions: {} };
  let experimentPath = modelPath.replace(/\.model\.json$/, ".experiment.json");
  for (let suffix = 2; documents.some(document => document.path === experimentPath); suffix++) {
    experimentPath = modelPath.replace(/\.model\.json$/, `-${suffix}.experiment.json`);
  }
  const experiment = defaultExperiment(modelPath.split("/").at(-1)!, layoutView === null ? null : layoutPath.split("/").at(-1)!);
  return { modelPath, model, layoutPath, layout, experimentPath, experiment,
    saved: { model, layout, experiment }, versions: { model: view.version, layout: layoutView?.version ?? null, experiment: null } };
}

/** Loads workspace documents, tracks external changes and saves command edits with conditional versions (stage 1 design §6.2). */
export function useWorkspace(): Workspace {
  const language = useLanguage();
  const [sourceCatalog, setCatalog] = useState<Catalog | null>(null);
  const catalog = useMemo(() => sourceCatalog === null ? null : localizeCatalog(sourceCatalog, language), [sourceCatalog, language]);
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const preferences = useRef<ReturnType<typeof readSelection> | null>(null);
  if (preferences.current === null) preferences.current = readSelection();
  const [editor, dispatch] = useReducer(editorReducer, initialEditorState);
  const { loaded, conflictPath } = editor;
  const models = documents.filter(document => document.kind === "MODEL").map(document => document.path).sort();
  const experiments = selectedModel === null ? [] : experimentsForModel(documents, selectedModel);
  if (loaded?.modelPath === selectedModel && loaded?.versions.experiment === null && !experiments.includes(loaded.experimentPath)) experiments.push(loaded.experimentPath);
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

  const load = useCallback(async (experimentPath: string, recoveryLayoutPath?: string, model?: { path: string; documents: DocumentEntry[] }) => {
    const current = ++generation.current;
    loadInFlight.current = true;
    setLoading(true);
    setProblem(null);
    try {
      const next = model === undefined ? await loadExperiment(experimentPath, recoveryLayoutPath) : await loadModel(model.path, model.documents);
      if (current === generation.current) {
        persistenceRevision.current += 1;
        loadedRef.current = next;
        deferredChanges.current.clear();
        setExternalChanges({});
        setSelectedModel(next.modelPath);
        preferences.current = rememberSelection(next.modelPath, next.experimentPath, preferences.current!);
        dispatch({ type: "open", loaded: next });
        return true;
      }
    } catch (error) {
      if (current === generation.current) setProblem(problemOf(error));
    } finally {
      if (current === generation.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
    return false;
  }, []);

  const open = useCallback(
    async (experimentPath: string, discardChanges = false) => {
      if (saveInFlight.current || (dirty && !discardChanges)) return false;
      return load(experimentPath, experimentPath === openedExperimentPath ? recoveryLayoutPath : undefined);
    },
    [dirty, load, openedExperimentPath, recoveryLayoutPath],
  );

  const openModel = useCallback(async (modelPath: string, discardChanges = false) => {
    if (loadInFlight.current || saveInFlight.current || (dirty && !discardChanges)) return false;
    const experiment = preferredExperiment(documents, modelPath, preferences.current?.experiments[modelPath]);
    setSelectedModel(modelPath);
    if (loadedRef.current?.modelPath !== modelPath) {
      loadedRef.current = null;
      setExternalChanges({});
      dispatch({ type: "close" });
    }
    return experiment === null ? load("", undefined, { path: modelPath, documents }) : load(experiment);
  }, [dirty, documents, load]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshDocuments = async (): Promise<DocumentEntry[] | null> => {
      const documents = await api.documents();
      if (!active) return null;
      setDocuments(documents);
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
          changes = current === null ? [] : (["model", "layout", "experiment"] as const).filter(kind => current.versions[kind] !== null).map((kind) => {
            const path = current[`${kind}Path`];
            return {
              path,
              kind: kind === "model" ? "MODEL" : kind === "layout" ? "LAYOUT" : "EXPERIMENT",
              version: versions.get(path) ?? null,
            };
          });
        } else if (response.changes.some((change) => change.kind === "EXPERIMENT" || change.kind === "MODEL")) {
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
        const paths = documents.filter((document) => document.kind === "MODEL").map((document) => document.path).sort();
        setCatalog(nextCatalog);
        setDocuments(documents);
        const modelPath = paths.find(path => path === preferences.current?.model) ?? paths[0];
        if (modelPath !== undefined) {
          setSelectedModel(modelPath);
          const experiment = preferredExperiment(documents, modelPath, preferences.current?.experiments[modelPath]);
          if (experiment === null) await load("", undefined, { path: modelPath, documents });
          else await load(experiment);
        }
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
    if (loaded === null || loadInFlight.current || conflictPath !== null || saveInFlight.current) return false;
    if (!dirty && loaded.versions.experiment !== null) return true;
    const saved = loaded;
    const current = generation.current;
    saveInFlight.current = true;
    setSaving(true);
    setProblem(null);
    try {
      for (const kind of ["layout", "model", "experiment"] as const) {
        if (!dirtyDocuments(saved)[kind] && !(kind === "experiment" && saved.versions.experiment === null)) continue;
        const path = saved[`${kind}Path`];
        savingPaths.current.add(path);
        try {
          const entry = await api.saveDocument(path, { [kind]: saved[kind] }, saved.versions[kind]);
          if (current !== generation.current) return false;
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
          if (kind === "experiment") setDocuments(previous => [...previous.filter(document => document.path !== path), {
            path, kind: "EXPERIMENT", version: entry.version, modelRef: saved.experiment.modelRef,
          }]);
        } catch (error) {
          if (current !== generation.current) return false;
          if (error instanceof ApiError && error.status === 409) dispatch({ type: "conflict", path });
          else setProblem(problemOf(error));
          return false;
        } finally {
          flushChange(path);
        }
      }
      return true;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [loaded, dirty, conflictPath, flushChange]);

  const reportProblem = useCallback((error: unknown) => setProblem(problemOf(error)), []);

  const storeDocuments = useCallback(async (drafts: DocumentDraft[], confirmReplace?: ConfirmReplace, validate = true) => {
    if (loadInFlight.current || saveInFlight.current) return false;
    saveInFlight.current = true;
    loadInFlight.current = true;
    setLoading(true);
    setProblem(null);
    for (const draft of drafts) savingPaths.current.add(draft.path);
    try {
      if (!await writeDocuments(drafts, confirmReplace, validate)) return false;
      const experiment = drafts.find(draft => draft.content.experiment != null)?.path;
      const affectsOpen = loaded !== null && drafts.some(draft =>
        [loaded.modelPath, loaded.layoutPath, loaded.experimentPath].includes(draft.path));
      if (experiment !== undefined || affectsOpen) await load(experiment ?? loaded!.experimentPath);
      return true;
    } catch (error) {
      reportProblem(error);
      return false;
    } finally {
      // A partial multi-document operation is visible in storage and in the picker, even when a later write fails.
      try {
        const documents = await api.documents();
        setDocuments(documents);
      } catch { /* A later workspace poll retries refreshing the picker. */ }
      for (const draft of drafts) flushChange(draft.path);
      saveInFlight.current = false;
      loadInFlight.current = false;
      setLoading(false);
    }
  }, [loaded, load, flushChange, reportProblem]);

  const removeDocuments = useCallback(async (plan: DocumentEntry[], discardChanges = false, runs: RunStorageEntry[] = []) => {
    if (loaded === null || plan.length === 0 || loadInFlight.current || saveInFlight.current || (dirty && !discardChanges)) return false;
    saveInFlight.current = true;
    loadInFlight.current = true;
    setLoading(true);
    setProblem(null);
    for (const entry of plan) savingPaths.current.add(entry.path);
    let deleted: string[] = [];
    let deletedRuns: string[] = [];
    let failure: ApiProblem | null = null;
    let reason = "";
    let verified = false;
    try {
      try {
        if (plan.some(entry => entry.kind === "MODEL")) {
          const latest = await documentsToDelete(loaded, "model");
          if (latest.length !== plan.length || plan.some((entry, i) => entry.path !== latest[i].path || entry.version !== latest[i].version)) {
            throw new MessageError("file.deletePlanChanged");
          }
        }
        if (runs.length > 0) {
          const current = await api.documents();
          if (plan.some(entry => !current.some(stored => stored.path === entry.path && stored.version === entry.version))) {
            throw new MessageError("file.deletePlanChanged");
          }
        }
        const latestRuns = await runsToDelete(plan);
        if (latestRuns.length !== runs.length || runs.some(run => !latestRuns.some(latest =>
          latest.directory === run.directory && latest.experiment === run.experiment && latest.sizeBytes === run.sizeBytes))) {
          throw new MessageError("file.runDeletePlanChanged");
        }
        for (const run of runs) {
          await api.deleteRunDirectory(run.directory);
          deletedRuns.push(run.directory);
        }
        for (const entry of plan) {
          if (entry.kind !== "EXPERIMENT") await checkDeletionReferences(entry);
          await api.deleteDocument(entry.path, entry.version);
          deleted.push(entry.path);
          persistenceRevision.current += 1;
        }
      } catch (error) {
        failure = problemOf(error);
        reason = error instanceof Error ? error.message : t("app.workspace.requestFailed");
      }
      let remaining = documents.filter(entry => !deleted.includes(entry.path));
      try {
        remaining = await api.documents();
        deleted = plan.filter(entry => !remaining.some(current => current.path === entry.path)).map(entry => entry.path);
        if (failure !== null && runs.length > 0) {
          const [readable, obsolete] = await Promise.all([api.runs(), api.obsoleteRuns()]);
          const stored = new Set([...readable, ...obsolete].map(run => run.directory));
          deletedRuns = runs.filter(run => !stored.has(run.directory)).map(run => run.directory);
        }
        verified = true;
      } catch (error) {
        failure ??= problemOf(error);
        reason ||= error instanceof Error ? error.message : t("app.workspace.requestFailed");
      }
      const paths = new Set(remaining.map(entry => entry.path));
      const modelDeleted = !paths.has(loaded.modelPath);
      const reopen = modelDeleted || (loaded.versions.experiment !== null && !paths.has(loaded.experimentPath));
      if (reopen) {
        generation.current += 1;
        loadedRef.current = null;
        setSelectedModel(null);
        setExternalChanges({});
        dispatch({ type: "close" });
      }
      setDocuments(remaining);
      if (reopen) {
        const modelPath = modelDeleted ? preferredModel(remaining, preferences.current?.recentModels) : loaded.modelPath;
        if (modelPath !== null) {
          setSelectedModel(modelPath);
          const experiment = preferredExperiment(remaining, modelPath, preferences.current?.experiments[modelPath]);
          if (experiment === null) await load("", undefined, { path: modelPath, documents: remaining });
          else await load(experiment);
        }
      }
      return failure === null;
    } finally {
      for (const entry of plan) flushChange(entry.path);
      saveInFlight.current = false;
      loadInFlight.current = false;
      setLoading(false);
      if (failure !== null) setProblem({ ...failure, code: "FILE_PARTIAL_DELETE", message: t(verified ? "file.partialDelete" : "file.deleteUncertain", {
        deleted: [...deletedRuns, ...deleted].join(", ") || t("file.noFilesDeleted"),
        remaining: [...runs.filter(run => !deletedRuns.includes(run.directory)).map(run => run.directory), ...plan.filter(entry => !deleted.includes(entry.path)).map(entry => entry.path)].join(", ") || t("file.noFilesDeleted"), reason,
      }) });
    }
  }, [loaded, dirty, documents, load, flushChange]);

  const exportFiles = useCallback(async (saveFirst = false) => {
    if (loaded === null || loadInFlight.current || saveInFlight.current || conflictPath !== null || externalChange !== null) return null;
    setLoading(true);
    setProblem(null);
    try {
      if ((dirty || loaded.versions.experiment === null) && (!saveFirst || !await save())) return null;
      saveInFlight.current = true;
      loadInFlight.current = true;
      return await exportDocuments(loaded);
    }
    catch (error) { reportProblem(error); return null; }
    finally {
      saveInFlight.current = false;
      loadInFlight.current = false;
      setLoading(false);
    }
  }, [loaded, dirty, save, conflictPath, externalChange, reportProblem]);

  const reload = useCallback(async () => {
    if (loaded !== null && !saveInFlight.current && externalChange?.deleted !== true) {
      if (loaded.versions.experiment === null) await load("", undefined, { path: loaded.modelPath, documents });
      else await load(loaded.experimentPath, recoveryLayoutPath);
    }
  }, [loaded, load, recoveryLayoutPath, externalChange, documents]);

  return {
    catalog, models, selectedModel, experiments, loaded, loading, dirty, dirtyDocuments: changed, saving,
    conflict: conflictPath !== null, conflictPath, externalChange, problem, open, openModel, setParam, execute,
    canUndo: editor.past.length > 0, canRedo: editor.future.length > 0, undo, redo, save, reload, storeDocuments, removeDocuments, exportFiles, reportProblem,
  };
}
