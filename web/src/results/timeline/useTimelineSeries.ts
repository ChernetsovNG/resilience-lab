import { useEffect, useState } from "react";
import type { NodeSeriesMetrics, SeriesLoader } from "../series";

const emptyNodes: NodeSeriesMetrics[] = [];

/** Cancels obsolete loads and hides their data before the effect for the next selection runs. */
export function useTimelineSeries(
  loader: Pick<SeriesLoader, "load">, runId: string, variant: string | null, cell: string,
  replication: number, nodes: readonly string[], untilWindow: number, fromWindow = 0,
) {
  const nodesKey = JSON.stringify(nodes);
  const key = JSON.stringify([runId, variant, cell, replication, nodesKey, fromWindow, untilWindow]);
  const [state, setState] = useState<{ key: string; nodes: NodeSeriesMetrics[]; problem: string | null }>({
    key: "", nodes: [], problem: null,
  });
  const enabled = variant !== null && nodes.length > 0;
  useEffect(() => {
    if (variant === null || nodesKey === "[]") return;
    const controller = new AbortController();
    void loader.load({ runId, variant, cell, replication, nodes: JSON.parse(nodesKey), fromWindow, untilWindow, signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) setState({ key, nodes: loaded, problem: null });
      }, (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, nodes: [], problem: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [loader, runId, variant, cell, replication, nodesKey, fromWindow, untilWindow, key]);
  return {
    nodes: enabled && state.key === key ? state.nodes : emptyNodes,
    problem: enabled && state.key === key ? state.problem : null,
    loading: enabled && state.key !== key,
  };
}
