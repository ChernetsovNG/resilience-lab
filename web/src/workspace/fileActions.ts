import { ApiError, api } from "../api/apiClient";
import type { DocumentDraft, ExperimentFile } from "../api/apiTypes";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { MessageError } from "../i18n/MessageError";
import type { LoadedExperiment } from "./editor";
import { isObject } from "./params";
import { resolveRef } from "./paths";

export interface DownloadDocument { name: string; text: string }
export type ConfirmReplace = (paths: string[]) => boolean;
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

/** A runnable starting point: one client, one service, one request and ten independent replications. */
export function newExperiment(directory: string): DocumentDraft[] {
  const path = destination(directory);
  const name = nameOf(path);
  return [
    { path: `${path}/${name}.model.json`, content: { model: {
      schemaVersion: 5,
      blocks: {
        client: { type: "client", params: { load: { points: [{ time: "0s", rate: "10/s" }] }, deadline: "1s" } },
        service: { type: "service", params: { handlers: 1, queue: 10, processing: { kind: "fixed", mean: "10ms" } } },
      },
      connections: [{ id: "client-to-service", type: "request", from: "client", to: "service", params: {} }],
    } } },
    { path: `${path}/${name}.layout.json`, content: { layout: {
      schemaVersion: 1, positions: { client: { x: 0, y: 100 }, service: { x: 280, y: 100 } },
    } } },
    { path: `${path}/${name}.experiment.json`, content: { experiment: {
      schemaVersion: 1, modelRef: `${name}.model.json`, layoutRef: `${name}.layout.json`,
      execution: { replications: 10, seed: 1, warmup: "0ms", measurement: "1s", maxRealTime: "30s" },
      faults: [], grid: [], variants: [{ id: "baseline", label: t("file.baseline"), overrides: {} }],
    } } },
  ];
}

/** Copies the current drafts, including unsaved edits; all references stay inside the new directory. */
export function copyExperiment(loaded: LoadedExperiment, directory: string): DocumentDraft[] {
  const path = destination(directory);
  return [
    { path: `${path}/${nameOf(loaded.modelPath)}`, content: { model: loaded.model } },
    { path: `${path}/${nameOf(loaded.layoutPath)}`, content: { layout: loaded.layout } },
    { path: `${path}/${nameOf(loaded.experimentPath)}`, content: { experiment: {
      ...loaded.experiment, modelRef: nameOf(loaded.modelPath), layoutRef: nameOf(loaded.layoutPath),
    } } },
  ];
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
export async function writeDocuments(drafts: DocumentDraft[], confirmReplace?: ConfirmReplace): Promise<boolean> {
  const entries = await api.documents();
  const versions = new Map(entries.map(entry => [entry.path, entry.version]));
  const collisions = drafts.filter(draft => versions.has(draft.path)).map(draft => draft.path);
  if (collisions.length > 0) {
    if (confirmReplace === undefined) throw new MessageError("file.destinationExists", { paths: collisions.join(", ") });
    if (!confirmReplace(collisions)) return false;
  }
  for (const draft of drafts) {
    if (draft.content.experiment == null) continue;
    const report = await api.validate(draft.path, drafts);
    if (!report.valid) throw new ApiError(400, { code: "FILE_VALIDATION", message: t("file.invalidDocuments"), diagnostics: report.diagnostics });
  }
  const written: string[] = [];
  try {
    // Publish experiment references only after their model and layout have been written.
    const ordered = [...drafts].sort((a, b) => Number(a.content.experiment != null) - Number(b.content.experiment != null));
    for (const draft of ordered) {
      await api.saveDocument(draft.path, draft.content, versions.get(draft.path) ?? null);
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
