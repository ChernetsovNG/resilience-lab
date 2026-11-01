import type { EditorCommand } from "./editor";
import { ownEntry } from "./params";

export type AnnotationField = "description" | "notes";
export type Annotations = { description?: string | null; notes?: string | null };

/** Set the human-readable block name without changing its identity; blank text removes the optional name. */
export function setBlockTitle(id: string, value: string): EditorCommand {
  return documents => {
    const block = ownEntry(documents.model.blocks, id);
    if (block === undefined) return documents;
    const next = { ...block };
    if (value.trim() === "") delete next.title;
    else next.title = value.trim();
    return { ...documents, model: { ...documents.model, blocks: { ...documents.model.blocks, [id]: next } } };
  };
}

/** Edit one explanation verbatim in one history entry; an empty string removes its key. */
export function setAnnotation(target: "model" | "experiment" | { element: string }, field: AnnotationField, value: string): EditorCommand {
  const update = <T extends Annotations>(current: T): T => {
    const next = { ...current };
    if (value === "") delete next[field];
    else next[field] = value;
    return next;
  };
  return documents => {
    if (typeof target === "string") return { ...documents, [target]: update(documents[target]) };
    const id = target.element;
    const block = ownEntry(documents.model.blocks, id);
    if (block === undefined && !documents.model.connections.some(connection => connection.id === id)) return documents;
    const model = block === undefined
      ? { ...documents.model, connections: documents.model.connections.map(connection => connection.id === id ? update(connection) : connection) }
      : { ...documents.model, blocks: { ...documents.model.blocks, [id]: update(block) } };
    return { ...documents, model };
  };
}
