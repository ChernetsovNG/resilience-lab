import { useCallback, useEffect, useState, type SetStateAction } from "react";
import type { ResultsPanelSize } from "./ResultsPanel";

const storageKey = "resilience-lab.results-panel-size";

/**
 * Browser preference only; unavailable storage still permits changes for this session.
 * Every mount starts collapsed; requesting normal from collapsed opens the preferred mode.
 */
export function useResultsPanelSize() {
  const [state, setState] = useState<{ size: ResultsPanelSize; preferred: "normal" | "expanded" }>(() => {
    let preferred: "normal" | "expanded" = "normal";
    try {
      if (localStorage.getItem(storageKey) === "expanded") preferred = "expanded";
    } catch { /* Start collapsed when storage is unavailable. */ }
    return { size: "collapsed", preferred };
  });
  const setSize = useCallback((next: SetStateAction<ResultsPanelSize>) => {
    setState(current => {
      const requested = typeof next === "function" ? next(current.size) : next;
      const size = requested === "normal" && current.size === "collapsed" ? current.preferred : requested;
      return size === current.size ? current : { size, preferred: size === "collapsed" ? current.preferred : size };
    });
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, state.preferred); } catch { /* Keep the in-session preference. */ }
  }, [state.preferred]);
  return [state.size, setSize] as const;
}
