import { useSyncExternalStore } from "react";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "../results/confidence";

const preferenceKey = "resilience-lab.confidenceLevel";
const listeners = new Set<() => void>();

function savedLevel(): ConfidenceLevel {
  try {
    const saved = localStorage.getItem(preferenceKey);
    return CONFIDENCE_LEVELS.find(level => String(level) === saved) ?? 95;
  } catch { return 95; }
}

let level = savedLevel();
export const currentConfidenceLevel = (): ConfidenceLevel => level;

/** View preference only; storage failure still permits switching for the current session. */
export function setConfidenceLevel(next: ConfidenceLevel): void {
  level = next;
  try { localStorage.setItem(preferenceKey, String(next)); } catch { /* This session still uses the selected level. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Update mounted result views without changing documents, artifacts, or editor history. */
export function useConfidenceLevel(): ConfidenceLevel {
  return useSyncExternalStore(subscribe, currentConfidenceLevel);
}
