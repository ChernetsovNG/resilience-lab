import { useEffect, useState } from "react";
import type { DecodedConnection, SeriesLoader } from "../series";

const emptyConnections: DecodedConnection[] = [];

/** Cancels obsolete loads and hides their data before the effect for the next selection runs. */
export function useConnectionSeries(
  loader: Pick<SeriesLoader, "loadConnections">, runId: string, variant: string | null, cell: string,
  replication: number, connections: readonly string[], untilWindow: number, fromWindow = 0,
) {
  const connectionsKey = JSON.stringify(connections);
  const key = JSON.stringify([runId, variant, cell, replication, connectionsKey, fromWindow, untilWindow]);
  const [state, setState] = useState<{ key: string; connections: DecodedConnection[]; problem: string | null }>({
    key: "", connections: [], problem: null,
  });
  const enabled = variant !== null && connections.length > 0;
  useEffect(() => {
    if (variant === null || connectionsKey === "[]") return;
    const controller = new AbortController();
    void loader.loadConnections({ runId, variant, cell, replication, connections: JSON.parse(connectionsKey), fromWindow, untilWindow, signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) setState({ key, connections: loaded, problem: null });
      }, (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, connections: [], problem: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [loader, runId, variant, cell, replication, connectionsKey, fromWindow, untilWindow, key]);
  return {
    connections: enabled && state.key === key ? state.connections : emptyConnections,
    problem: enabled && state.key === key ? state.problem : null,
    loading: enabled && state.key !== key,
  };
}
