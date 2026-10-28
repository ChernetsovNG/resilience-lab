import { useEffect, useState } from "react";
import { api } from "../api/apiClient";
import type { ApiProblem, DocumentDraft, ValidationView } from "../api/apiTypes";
import { dirtyDocuments, type LoadedExperiment } from "../workspace/editor";
import { problemOf } from "../workspace/useWorkspace";

interface ValidationState {
  snapshot: LoadedExperiment;
  report: ValidationView | null;
  problem: ApiProblem | null;
}

/** Validates a document snapshot after 500 ms of inactivity; obsolete successes and failures are discarded. */
export function useValidation(loaded: LoadedExperiment | null) {
  const [state, setState] = useState<ValidationState | null>(null);

  useEffect(() => {
    if (loaded === null) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const changed = dirtyDocuments(loaded);
      const drafts: DocumentDraft[] = (["model", "layout", "experiment"] as const)
        .filter((kind) => changed[kind])
        .map((kind) => ({ path: loaded[`${kind}Path`], content: { [kind]: loaded[kind] } }));
      void api.validate(loaded.experimentPath, drafts).then(
        (report) => { if (active) setState({ snapshot: loaded, report, problem: null }); },
        (error: unknown) => { if (active) setState({ snapshot: loaded, report: null, problem: problemOf(error) }); },
      );
    }, 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [loaded]);

  const current = state?.snapshot === loaded ? state : null;
  return {
    report: current?.report ?? null,
    problem: current?.problem ?? null,
    pending: loaded !== null && current === null,
  };
}
