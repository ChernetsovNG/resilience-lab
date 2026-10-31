import type { Catalog, DocumentDraft, ExperimentFile, LayoutFile, ModelFile } from "../api/apiTypes";
import { elementOf, isObject, ownEntry, withParam } from "./params";
import { reconcileParameter } from "./parameterApplicability";

/** Document content only: selection, pages and panels do not belong in the history. */
export interface EditorDocuments {
  model: ModelFile;
  layout: LayoutFile;
  experiment: ExperimentFile;
}

export type DocumentKind = keyof EditorDocuments;

/** A pure, immutable edit; one command may change several documents atomically. */
export type EditorCommand = (documents: EditorDocuments) => EditorDocuments;

/** An open experiment, its saved snapshots and the versions used for conditional writes. */
export interface LoadedExperiment extends EditorDocuments {
  experimentPath: string;
  modelPath: string;
  layoutPath: string;
  saved: EditorDocuments;
  /** A missing layout has empty in-memory content and a null version until its first write. */
  versions: Record<DocumentKind, string | null>;
}

type ModelElement = ModelFile["blocks"][string] | ModelFile["connections"][number];
const elementOrigins = new WeakMap<ModelElement["params"], object>();

/** Session-only identity follows parameter records: renames retain them, edits register copies; nothing enters document JSON. */
export function elementIdentity(element: ModelElement): object {
  return elementOrigins.get(element.params) ?? element.params;
}

function rememberElementCopies(before: ModelFile, after: ModelFile): void {
  if (before === after) return;
  const remember = (previous: ModelElement, current: ModelElement) => {
    if (previous.params !== current.params && !elementOrigins.has(current.params)) {
      elementOrigins.set(current.params, elementIdentity(previous));
    }
  };
  for (const [id, block] of Object.entries(after.blocks)) {
    const previous = ownEntry(before.blocks, id);
    if (previous?.type === block.type) remember(previous, block);
  }
  const connections = new Map(before.connections.map((connection) => [connection.id, connection]));
  for (const connection of after.connections) {
    const previous = connections.get(connection.id);
    if (previous !== undefined && previous.type === connection.type && previous.from === connection.from && previous.to === connection.to) {
      remember(previous, connection);
    }
  }
}

interface EditorState {
  loaded: LoadedExperiment | null;
  past: EditorDocuments[];
  future: EditorDocuments[];
  conflictPath: string | null;
}

type EditorAction =
  | { type: "close" }
  | { type: "open"; loaded: LoadedExperiment }
  | { type: "command"; command: EditorCommand }
  | { type: "undo" | "redo" }
  | { type: "saved"; kind: DocumentKind; documents: EditorDocuments; version: string }
  | { type: "conflict"; path: string };

export const initialEditorState: EditorState = { loaded: null, past: [], future: [], conflictPath: null };

// Only document content enters history; a save must never roll back versions or saved snapshots on undo.
function documentsOf({ model, layout, experiment }: EditorDocuments): EditorDocuments {
  return { model, layout, experiment };
}

/** Structural document equality; object key order does not affect the result. */
export function documentValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => documentValuesEqual(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && documentValuesEqual(left[key], right[key]));
}

/** Per-document unsaved changes, including edits that returned to their saved values. */
export function dirtyDocuments(loaded: LoadedExperiment | null): Record<DocumentKind, boolean> {
  return {
    layout: loaded !== null && (
      (loaded.versions.layout === null && loaded.experiment.layoutRef != null) || !documentValuesEqual(loaded.layout, loaded.saved.layout)
    ),
    model: loaded !== null && !documentValuesEqual(loaded.model, loaded.saved.model),
    experiment: loaded !== null && !documentValuesEqual(loaded.experiment, loaded.saved.experiment),
  };
}

/** Changed documents in the API draft format, shared by validation and cost estimation. */
export function documentDrafts(loaded: LoadedExperiment): DocumentDraft[] {
  const changed = dirtyDocuments(loaded);
  return (["model", "layout", "experiment"] as const)
    .filter((kind) => changed[kind] || (kind === "experiment" && loaded.versions.experiment === null))
    .map((kind) => ({ path: loaded[`${kind}Path`], content: { [kind]: loaded[kind] } }));
}

/** Edits one model parameter and reconciles kind-dependent fields in the same snapshot; other documents are untouched. */
export function setModelParam(id: string, name: string, value: unknown, catalog?: Catalog): EditorCommand {
  return (documents) => {
    let model = withParam(documents.model, id, name, value);
    const root = name.split(".")[0];
    const element = elementOf(documents.model, id);
    const descriptor = catalog?.types.find(type => type.id === element?.type)?.params.find(param => param.name === root);
    if (descriptor !== undefined) {
      const next = elementOf(model, id)!.params[root];
      const reconciled = reconcileParameter(descriptor, element?.params[root], next);
      if (reconciled !== next) model = withParam(model, id, root, reconciled);
    }
    return { ...documents, model };
  };
}

/** Commands and history share the same document snapshots; saves update only persistence metadata. */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "close") return initialEditorState;
  if (action.type === "open") {
    if (state.loaded?.modelPath === action.loaded.modelPath) rememberElementCopies(state.loaded.saved.model, action.loaded.model);
    return { ...initialEditorState, loaded: action.loaded };
  }
  const { loaded, past, future } = state;
  if (loaded === null) return state;
  switch (action.type) {
    case "command": {
      const before = documentsOf(loaded);
      let after = action.command(before);
      if (!documentValuesEqual(before.layout, after.layout) && after.experiment.layoutRef == null) {
        after = { ...after, experiment: { ...after.experiment, layoutRef: loaded.layoutPath.split("/").at(-1)! } };
      }
      if (documentValuesEqual(before, after)) return state;
      rememberElementCopies(before.model, after.model);
      return { ...state, loaded: { ...loaded, ...after }, past: [...past, before].slice(-100), future: [] };
    }
    case "undo": {
      const previous = past.at(-1);
      if (previous === undefined) return state;
      return { ...state, loaded: { ...loaded, ...previous }, past: past.slice(0, -1), future: [documentsOf(loaded), ...future] };
    }
    case "redo": {
      const next = future[0];
      if (next === undefined) return state;
      return { ...state, loaded: { ...loaded, ...next }, past: [...past, documentsOf(loaded)].slice(-100), future: future.slice(1) };
    }
    case "saved":
      return { ...state, loaded: {
        ...loaded,
        saved: { ...loaded.saved, [action.kind]: action.documents[action.kind] },
        versions: { ...loaded.versions, [action.kind]: action.version },
      } };
    case "conflict":
      return { ...state, conflictPath: action.path };
  }
}
