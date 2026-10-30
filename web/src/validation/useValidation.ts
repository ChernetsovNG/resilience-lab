import { useEffect, useState } from "react";
import { api } from "../api/apiClient";
import type { ApiProblem, ValidationView } from "../api/apiTypes";
import { documentDrafts, type LoadedExperiment } from "../workspace/editor";
import { problemOf } from "../workspace/useWorkspace";

interface ValidationState {
  snapshot: LoadedExperiment;
  report: ValidationView | null;
  problem: ApiProblem | null;
}

/** Validates a document snapshot after 500 ms of inactivity; obsolete successes and failures are discarded. */
export function useValidation(loaded: LoadedExperiment | null, hasClient = true) {
  const [state, setState] = useState<ValidationState | null>(null);

  useEffect(() => {
    if (loaded === null) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.validate(loaded.experimentPath, documentDrafts(loaded)).then(
        (report) => { if (active) setState({ snapshot: loaded, report, problem: null }); },
        (error: unknown) => { if (active) setState({ snapshot: loaded, report: null, problem: problemOf(error) }); },
      );
    }, 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [loaded]);

  const current = state?.snapshot === loaded ? state : null;
  const report = current?.report ?? null;
  return {
    report: report === null || hasClient ? report : { ...report, diagnostics: report.diagnostics.filter(diagnostic => !diagnostic.code.startsWith("TOPOLOGY_")) },
    problem: current?.problem ?? null,
    pending: loaded !== null && current === null,
  };
}
