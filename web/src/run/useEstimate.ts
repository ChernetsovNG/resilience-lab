import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/apiClient";
import type { ApiProblem, ExperimentEstimate } from "../api/apiTypes";
import { documentDrafts, type LoadedExperiment } from "../workspace/editor";
import { problemOf } from "../workspace/useWorkspace";

interface EstimateState {
  snapshot: LoadedExperiment;
  validity: ReadonlySet<string>;
  value: ExperimentEstimate | null;
  problem: ApiProblem | null;
  pending: boolean;
}

type EstimateResult = { value: ExperimentEstimate; problem: null } | { value: null; problem: ApiProblem };

/** Estimates the current draft snapshot on demand; edits, field validity and newer requests invalidate late responses. */
export function useEstimate(loaded: LoadedExperiment | null, validity: ReadonlySet<string>) {
  const [state, setState] = useState<EstimateState | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, [loaded, validity]);

  const request = useCallback(async (): Promise<EstimateResult | null> => {
    if (loaded === null || validity.size > 0) return null;
    const current = ++generation.current;
    const live = () => current === generation.current;
    setState({ snapshot: loaded, validity, value: null, problem: null, pending: true });
    try {
      const value = await api.estimate(loaded.experimentPath, documentDrafts(loaded));
      if (!live()) return null;
      setState({ snapshot: loaded, validity, value, problem: null, pending: false });
      return { value, problem: null };
    } catch (error) {
      if (!live()) return null;
      const problem = problemOf(error);
      setState({ snapshot: loaded, validity, value: null, problem, pending: false });
      return { value: null, problem };
    }
  }, [loaded, validity]);

  const current = state?.snapshot === loaded && state.validity === validity ? state : null;
  return { estimate: current?.value ?? null, problem: current?.problem ?? null, pending: current?.pending ?? false, request };
}
