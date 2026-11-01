import { useEffect, useState } from "react";
import type { ResultsPanelSize } from "./ResultsPanel";

const storageKey = "resilience-lab.results-panel-size";

/** Browser preference only; unavailable storage still permits changes for this session. */
export function useResultsPanelSize() {
  const [size, setSize] = useState<ResultsPanelSize>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "normal" || saved === "expanded") return saved;
    } catch { /* Start collapsed when storage is unavailable. */ }
    return "collapsed";
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, size); } catch { /* Keep the in-session preference. */ }
  }, [size]);
  return [size, setSize] as const;
}
