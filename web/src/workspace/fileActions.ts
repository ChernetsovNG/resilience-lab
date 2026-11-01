import { ApiError, api } from "../api/apiClient";
import type { DocumentDraft, DocumentEntry, ExperimentFile, RunStorageEntry } from "../api/apiTypes";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { MessageError } from "../i18n/MessageError";
import type { LoadedExperiment } from "./editor";
import { isObject } from "./params";
import { resolveRef } from "./paths";
import { experimentsForModel } from "./modelSelection";

export interface DownloadDocument { name: string; text: string }
export type ConfirmReplace = (paths: string[]) => boolean | Promise<boolean>;
const nameOf = (path: string) => path.split("/").at(-1)!;

function destination(directory: string): string {
  const path = directory.trim();
  if (resolveRef("", path) !== path || path.split("/").some(part => part === ".results" || part === "." || part === "..") ||
    /[\\:\0]/.test(path)) throw new MessageError("file.invalidDirectory");
  return path;
}

function parseDocument(text: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
      if (typeof value !== "number" || !Number.isInteger(value) || Number.isSafeInteger(value)) return value;
      const rawJSON = (JSON as typeof JSON & { rawJSON?: (source: string) => unknown }).rawJSON;
      if (context?.source !== undefined && rawJSON !== undefined) return rawJSON(context.source);
      throw new MessageError("file.unsafeNumber", { name });
    });
  } catch (error) {
    if (error instanceof MessageError) throw error;
    throw new MessageError("file.invalidJson", { name });
  }
  if (!isObject(parsed)) throw new MessageError("file.invalidJson", { name });
  return parsed;
}

/** Default question for a model: one baseline and ten independent replications. */
export function defaultExperiment(modelRef: string, layoutRef: string | null): ExperimentFile {
  return {
    schemaVersion: 3, modelRef, layoutRef,
    execution: { replications: 10, seed: 1, warmup: "10s", measurement: "60s", maxRealTime: "30s" },
    faults: [], grid: [], variants: [{ id: "baseline", label: t("file.baseline"), overrides: {} }],
  };
}

/** A starting point with model, layout and ten independent replications; the canvas starts empty. */
export function newModel(directory: string): DocumentDraft[] {
  const path = destination(directory);
  const name = nameOf(path);
  return [
    { path: `${path}/${name}.model.json`, content: { model: {
      schemaVersion: 6,
      blocks: {}, connections: [],
    } } },
    { path: `${path}/${name}.layout.json`, content: { layout: {
      schemaVersion: 2, sizes: {}, edges: {}, positions: {},
    } } },
    { path: `${path}/${name}.experiment.json`, content: { experiment: defaultExperiment(`${name}.model.json`, `${name}.layout.json`) } },
  ];
}

/** Creates another question for the current model without writing the source documents. */
export function newExperiment(loaded: LoadedExperiment, name: string): DocumentDraft[] {
  const filename = destination(name).replace(/\.experiment\.json$/, "");
  if (filename.includes("/")) throw new MessageError("file.invalidExperimentName");
  const path = loaded.modelPath.replace(/[^/]+$/, `${filename}.experiment.json`);
  return [
    ...(loaded.versions.layout === null ? [{ path: loaded.layoutPath, content: { layout: loaded.layout } }] : []),
    { path, content: { experiment: defaultExperiment(relativeRef(path, loaded.modelPath), relativeRef(path, loaded.layoutPath)) } },
  ];
}

function relativeRef(from: string, to: string): string {
  const base = from.split("/").slice(0, -1), target = to.split("/");
  while (base.length > 0 && base[0] === target[0]) { base.shift(); target.shift(); }
  return [...base.map(() => ".."), ...target].join("/");
}

/** Copies the model and all its questions, retaining drafts and relative paths without basename collisions. */
export async function copyModel(loaded: LoadedExperiment, directory: string): Promise<DocumentDraft[]> {
  const path = destination(directory);
  const entries = await api.documents();
  const sources = new Map<string, DocumentDraft>([
    [loaded.modelPath, { path: loaded.modelPath, content: { model: loaded.model } }],
  ]);
  if (loaded.experiment.layoutRef != null || loaded.versions.layout !== null) {
    sources.set(loaded.layoutPath, { path: loaded.layoutPath, content: { layout: loaded.layout } });
  }
  const experiments = new Set([loaded.experimentPath, ...experimentsForModel(entries, loaded.modelPath)]);
  for (const experimentPath of experiments) {
    const experiment = experimentPath === loaded.experimentPath ? loaded.experiment : (await api.document(experimentPath)).content.experiment;
    if (experiment == null) throw new MessageError("app.workspace.notExperiment", { path: experimentPath });
    sources.set(experimentPath, { path: experimentPath, content: { experiment } });
    if (experiment.layoutRef == null) continue;
    const layoutPath = resolveRef(experimentPath, experiment.layoutRef);
    if (layoutPath === null) throw new MessageError("app.workspace.layoutRefOutside", { path: experimentPath });
    if (!sources.has(layoutPath)) {
      const layout = (await api.document(layoutPath)).content.layout;
      if (layout == null) throw new MessageError("app.workspace.notLayout", { path: layoutPath });
      sources.set(layoutPath, { path: layoutPath, content: { layout } });
    }
  }
  const common = loaded.modelPath.split("/").slice(0, -1);
  while ([...sources.keys()].some(source => !source.startsWith(`${common.join("/")}/`)) && common.length > 0) common.pop();
  const prefix = common.length === 0 ? "" : `${common.join("/")}/`;
  const relocate = (source: string) => `${path}/${source.slice(prefix.length)}`;
  return [...sources.values()].map(source => {
    const copiedPath = relocate(source.path);
    const experiment = source.content.experiment;
    if (experiment == null) return { ...source, path: copiedPath };
    const layoutPath = experiment.layoutRef == null ? null : source.path === loaded.experimentPath ? loaded.layoutPath
      : resolveRef(source.path, experiment.layoutRef);
    return { path: copiedPath, content: { experiment: { ...experiment,
      modelRef: relativeRef(copiedPath, relocate(loaded.modelPath)),
      layoutRef: layoutPath === null ? null : relativeRef(copiedPath, relocate(layoutPath)),
    } } };
  });
}

/** Reads every selected file before any write. Selected references are relocated together, including shared models. */
export async function readImports(files: readonly Pick<File, "name" | "text">[], directory: string): Promise<DocumentDraft[]> {
  const path = destination(directory);
  if (files.length === 0) throw new MessageError("file.selectFiles");
  const names = new Set(files.map(file => file.name));
  if (names.size !== files.length) throw new MessageError("file.duplicateFiles");
  return Promise.all(files.map(async file => {
    const kind = /\.(model|layout|experiment)\.json$/.exec(file.name)?.[1];
    if (kind === undefined || nameOf(file.name) !== file.name || resolveRef("", file.name) !== file.name) {
      throw new MessageError("file.invalidFile", { name: file.name });
    }
    let value = parseDocument(await file.text(), file.name);
    if (kind === "experiment") {
      value = { ...value };
      const experiment = value as ExperimentFile;
      for (const key of ["modelRef", "layoutRef"] as const) {
        const ref = experiment[key];
        if (typeof ref === "string" && names.has(nameOf(ref))) experiment[key] = nameOf(ref);
      }
    }
    return { path: `${path}/${file.name}`, content: { [kind]: value } } as DocumentDraft;
  }));
}

/** Checks all collisions before writing. Only an explicit confirmation permits version-conditional replacement. */
export async function writeDocuments(
  drafts: DocumentDraft[], confirmReplace?: ConfirmReplace, validate = true, onWritten?: (entry: DocumentEntry) => void,
): Promise<boolean> {
  const entries = await api.documents();
  const versions = new Map(entries.map(entry => [entry.path, entry.version]));
  const collisions = drafts.filter(draft => versions.has(draft.path)).map(draft => draft.path);
  if (collisions.length > 0) {
    if (confirmReplace === undefined) throw new MessageError("file.destinationExists", { paths: collisions.join(", ") });
    if (!await confirmReplace(collisions)) return false;
  }
  for (const draft of drafts) {
    if (!validate || draft.content.experiment == null) continue;
    const report = await api.validate(draft.path, drafts);
    if (!report.valid) throw new ApiError(400, { code: "FILE_VALIDATION", message: t("file.invalidDocuments"), diagnostics: report.diagnostics });
  }
  const written: string[] = [];
  try {
    // Publish experiment references only after their model and layout have been written.
    const ordered = [...drafts].sort((a, b) => Number(a.content.experiment != null) - Number(b.content.experiment != null));
    for (const draft of ordered) {
      const entry = await api.saveDocument(draft.path, draft.content, versions.get(draft.path) ?? null);
      onWritten?.(entry);
      written.push(draft.path);
    }
  } catch (error) {
    if (written.length === 0) throw error;
    const reason = error instanceof ApiError ? backendMessage(error.problem) : error instanceof Error ? error.message : t("app.workspace.requestFailed");
    throw new ApiError(error instanceof ApiError ? error.status : 500, {
      code: "FILE_PARTIAL_WRITE", message: t("file.partialWrite", { paths: written.join(", "), reason }),
      diagnostics: error instanceof ApiError ? error.problem.diagnostics : [],
    });
  }
  return true;
}

/** Reads experiment contents and their current versions, including references outside the model's directory. Omits documents removed since listing. */
export async function storedExperiments(entries: readonly DocumentEntry[]) {
  return (await Promise.all(entries.filter(entry => entry.kind === "EXPERIMENT").map(async entry => {
    try {
      const view = await api.document(entry.path);
      const experiment = view.content.experiment;
      if (experiment == null) throw new MessageError("app.workspace.notExperiment", { path: entry.path });
      return [{ entry: { ...entry, version: view.version }, experiment }];
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  }))).flat();
}

/** Checks surviving references immediately before removing a model or layout. */
export async function checkDeletionReferences(entry: DocumentEntry): Promise<void> {
  const entries = await api.documents();
  const paths = entry.kind === "MODEL" ? new Set(experimentsForModel(entries, entry.path)) : null;
  for (const { entry: source, experiment } of await storedExperiments(paths === null ? entries : entries.filter(source => paths.has(source.path)))) {
    const ref = entry.kind === "MODEL" ? experiment.modelRef : experiment.layoutRef;
    if (ref != null && resolveRef(source.path, ref) === entry.path) throw new MessageError("file.deletePlanChanged");
  }
}

/** Snapshots stored references and versions before confirmation; shared and unreferenced layouts stay on disk. */
export async function documentsToDelete(loaded: LoadedExperiment, target: "model" | "experiment"): Promise<DocumentEntry[]> {
  const currentExperiment: DocumentEntry = { path: loaded.experimentPath, kind: "EXPERIMENT", version: loaded.versions.experiment!, modelRef: loaded.saved.experiment.modelRef };
  if (target === "experiment") return loaded.versions.experiment === null ? [] : [currentExperiment];
  const entries = await api.documents();
  const experiments = await storedExperiments(entries);
  const owned = experiments.filter(({ entry, experiment }) => resolveRef(entry.path, experiment.modelRef) === loaded.modelPath);
  const layouts = new Set<string>();
  for (const { entry, experiment } of owned) {
    if (experiment.layoutRef != null) {
      const path = resolveRef(entry.path, experiment.layoutRef);
      if (path === null) throw new MessageError("app.workspace.layoutRefOutside", { path: entry.path });
      layouts.add(path);
    }
  }
  for (const { entry, experiment } of experiments) {
    if (resolveRef(entry.path, experiment.modelRef) === loaded.modelPath || experiment.layoutRef == null) continue;
    const path = resolveRef(entry.path, experiment.layoutRef);
    if (path !== null) layouts.delete(path);
  }
  const ordered = [
    ...owned.map(({ entry }) => entry).sort((a, b) => a.path.localeCompare(b.path)),
    ...entries.filter(entry => entry.kind === "LAYOUT" && layouts.has(entry.path)).sort((a, b) => a.path.localeCompare(b.path)),
    { path: loaded.modelPath, kind: "MODEL" as const, version: loaded.versions.model!, modelRef: null },
  ];
  return ordered.map(entry => {
    const kind = (["model", "layout", "experiment"] as const).find(kind => loaded[`${kind}Path`] === entry.path);
    return kind === undefined || loaded.versions[kind] === null ? entry : { ...entry, version: loaded.versions[kind]! };
  });
}

/** Manifest paths identify ownership even when equal experiment filenames share a results directory. */
export async function runsToDelete(documents: DocumentEntry[]): Promise<RunStorageEntry[]> {
  const experiments = new Set(documents.filter(entry => entry.kind === "EXPERIMENT").map(entry => entry.path));
  const [runs, obsolete, jobs] = await Promise.all([api.runs(), api.obsoleteRuns(), api.jobs()]);
  const active = jobs.find(job => experiments.has(job.experiment) && (job.status === "QUEUED" || job.status === "RUNNING"));
  if (active !== undefined) throw new MessageError("file.activeExperiment", { experiment: active.experiment, job: active.id });
  return [...runs, ...obsolete].filter(run => run.experiment != null && experiments.has(run.experiment));
}

/** Fetches canonical server text without reserializing numbers, defaults or key order in the browser. */
export async function exportDocuments(loaded: LoadedExperiment): Promise<DownloadDocument[]> {
  const paths = [loaded.modelPath,
    ...(loaded.experiment.layoutRef != null || loaded.versions.layout !== null ? [loaded.layoutPath] : []), loaded.experimentPath];
  return Promise.all(paths.map(async path => ({ name: nameOf(path), text: (await api.documentText(path)).text })));
}

/** Download separate JSON files using the browser's native File/Blob facilities. */
export function downloadDocuments(files: DownloadDocument[]): void {
  for (const file of files) {
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = file.name;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
