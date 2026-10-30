import type { DocumentEntry } from "../api/apiTypes";
import { resolveRef } from "./paths";
import { isObject } from "./params";

/** References are relative to each experiment, including experiments outside the model's directory. */
export function experimentsForModel(entries: readonly DocumentEntry[], modelPath: string): string[] {
  return entries.filter(entry => entry.kind === "EXPERIMENT" && entry.modelRef != null &&
    resolveRef(entry.path, entry.modelRef) === modelPath).map(entry => entry.path).sort();
}

export function preferredExperiment(entries: readonly DocumentEntry[], modelPath: string, last?: string): string | null {
  const paths = experimentsForModel(entries, modelPath);
  return last !== undefined && paths.includes(last) ? last : paths[0] ?? null;
}

const key = "resilience-lab.workspace-selection";
interface Selection { model: string | null; experiments: Record<string, string> }

/** Browser preferences are optional: unavailable storage and malformed values do not prevent opening a model. */
export function readSelection(): Selection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (isObject(value) && typeof value.model === "string" && isObject(value.experiments)) {
      return { model: value.model, experiments: Object.fromEntries(Object.entries(value.experiments).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
    }
  } catch { /* Storage may be unavailable. */ }
  return { model: null, experiments: {} };
}

export function rememberSelection(model: string, experiment: string): void {
  try { localStorage.setItem(key, JSON.stringify({ model, experiments: { ...readSelection().experiments, [model]: experiment } })); }
  catch { /* Selection still works for this browser session. */ }
}
