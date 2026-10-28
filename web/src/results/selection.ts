import { useState } from "react";

/** Shared by result views; never serialized into model, layout or experiment documents. */
export interface ResultsSelection {
  pointId: string;
  replication: number;
  window: number | null;
}

const initial: ResultsSelection = { pointId: "p0", replication: 0, window: null };

export function useResultsSelection(runId: string | null) {
  const [state, setState] = useState({ runId, selection: initial });
  const selection = state.runId === runId ? state.selection : initial;
  if (state.runId !== runId) setState({ runId, selection });
  const select = (change: Partial<ResultsSelection>) => setState((previous) => ({
    runId, selection: { ...(previous.runId === runId ? previous.selection : initial), ...change },
  }));
  return { selection, select };
}
