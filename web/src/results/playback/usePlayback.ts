import { t } from "../../i18n";
import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { emptyCanvasValues, windowCanvasResults, type CanvasResults } from "../canvasResults";
import { seriesLoader, type DecodedConnection, type NodeSeriesMetrics, type SeriesLoader } from "../series";

export const PLAYBACK_WINDOWS_PER_SECOND = 10;

interface PlaybackOptions {
  runId: string;
  variant: string | null;
  pointId: string;
  replication: number;
  window: number | null;
  windowCount: number;
  nodes: readonly string[];
  results: CanvasResults | null;
  onWindowChange: (window: number | null) => void;
}

interface PreparedChunk {
  fromWindow: number;
  nodes: NodeSeriesMetrics[];
  connections: DecodedConnection[];
  problem: { error: unknown } | null;
}

/** Browser time only advances the shared window; series alone determine every frame. */
export function usePlayback({
  runId, variant, pointId, replication, window, windowCount, nodes, results, onWindowChange,
}: PlaybackOptions, loader: Pick<SeriesLoader, "load"> & Partial<Pick<SeriesLoader, "loadConnections">> = seriesLoader) {
  const key = JSON.stringify([runId, variant, pointId, replication]);
  const [state, setState] = useState({ key, playing: false });
  const [speed, setSpeed] = useState(1);
  if (state.key !== key) setState({ key, playing: false });
  const enabled = variant !== null && results !== null && windowCount > 0;
  const loadedNodes = [...new Set([...nodes, ...[...(results?.services.values() ?? [])].flatMap(service => service.instances?.map(instance => instance.id) ?? [])])];
  // Keep derived metrics to a working slice: at most 32 windows, using the artifact's 512-byte row estimate.
  const rangeSize = Math.max(1, Math.min(32, Math.floor(4 * 1024 * 1024 / (Math.max(1, loadedNodes.length) * 512))));
  const fromWindow = Math.floor((window ?? 0) / rangeSize) * rangeSize;
  const untilWindow = Math.min(windowCount, fromWindow + rangeSize);
  const connections = [...(results?.connections ?? [])].filter(([, connection]) => connection.hasOwnSeries).map(([id]) => id);
  const connectionLoader = loader.loadConnections === undefined ? seriesLoader : loader as Pick<SeriesLoader, "loadConnections">;
  const active = enabled && window !== null;
  const nodesKey = JSON.stringify(loadedNodes);
  const connectionsKey = JSON.stringify(connections);
  const chunksKey = JSON.stringify([key, nodesKey, connectionsKey, rangeSize, windowCount]);
  const [prepared, setPrepared] = useState(() => ({
    key: chunksKey, chunks: new Map<number, PreparedChunk>(), listeners: new Set<() => void>(),
  }));
  if (prepared.key !== chunksKey) setPrepared({
    key: chunksKey, chunks: new Map<number, PreparedChunk>(), listeners: new Set<() => void>(),
  });
  const subscribe = useCallback((listener: () => void) => {
    prepared.listeners.add(listener);
    return () => { prepared.listeners.delete(listener); };
  }, [prepared]);
  const snapshot = useCallback(() => active ? prepared.chunks.get(fromWindow) : undefined, [prepared, active, fromWindow]);
  const chunk = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => () => prepared.chunks.clear(), [prepared]);
  useEffect(() => {
    if (!active || variant === null) {
      prepared.chunks.clear();
      return;
    }
    const controller = new AbortController();
    const starts = untilWindow < windowCount ? [fromWindow, untilWindow] : [fromWindow];
    for (const [start, chunk] of prepared.chunks) {
      if (!starts.includes(start) || chunk.problem !== null) prepared.chunks.delete(start);
    }
    const finish = (chunk: PreparedChunk) => {
      if (controller.signal.aborted) return;
      prepared.chunks.set(chunk.fromWindow, chunk);
      for (const listener of prepared.listeners) listener();
    };
    for (const start of starts) {
      if (prepared.chunks.has(start)) continue;
      const request = { runId, variant, cell: pointId, replication, fromWindow: start,
        untilWindow: Math.min(windowCount, start + rangeSize), signal: controller.signal };
      // Warm the existing bounded LRU and retain derived metrics for only the current and next chunks.
      void Promise.all([
        nodesKey === "[]" ? Promise.resolve([]) : loader.load({ ...request, nodes: JSON.parse(nodesKey) }),
        connectionsKey === "[]" ? Promise.resolve([])
          : connectionLoader.loadConnections({ ...request, connections: JSON.parse(connectionsKey) }),
      ]).then(([loadedNodes, loadedConnections]) => {
        finish({ fromWindow: start, nodes: loadedNodes, connections: loadedConnections, problem: null });
      }, (error: unknown) => {
        // The foreground load retries and reports speculative failures.
        if (start === fromWindow) finish({ fromWindow: start, nodes: [], connections: [], problem: { error } });
      });
    }
    return () => controller.abort();
  }, [active, prepared, loader, connectionLoader, runId, variant, pointId, replication, nodesKey, connectionsKey, fromWindow, untilWindow, windowCount, rangeSize]);
  const loading = active && chunk === undefined;
  const currentFrame = active && chunk?.problem === null
    ? windowCanvasResults(results, chunk.nodes, window, fromWindow, chunk.connections) : null;
  const loadProblem = chunk?.problem;
  const problem = loadProblem != null ? loadProblem.error instanceof Error ? loadProblem.error.message : String(loadProblem.error)
    : (active && !loading && currentFrame === null
    ? t("results.playback.missingWindow") : null);
  const playing = enabled && state.key === key && state.playing && problem === null;
  const ready = currentFrame !== null;
  const frameKey = JSON.stringify([key, [...(results?.services.keys() ?? [])],
    [...(results?.connections ?? [])].map(([id, connection]) => [id, connection.from, connection.to, connection.type])]);
  const [retained, setRetained] = useState<{ key: string; frame: CanvasResults | null }>({ key: frameKey, frame: null });
  if (!active || retained.key !== frameKey) {
    if (retained.key !== frameKey || retained.frame !== null) setRetained({ key: frameKey, frame: null });
  } else if (currentFrame !== null && retained.frame?.window !== window) {
    setRetained({ key: frameKey, frame: currentFrame });
  }
  const previous = retained.key === frameKey ? retained.frame : null;
  const frame: CanvasResults | null = !active ? null : currentFrame ?? {
    ...(previous ?? {
      services: new Map([...results.services].map(([id, service]) => [id, {
        ...service, windowed: true, values: emptyCanvasValues(service.values),
      }])),
      connections: new Map([...results.connections].map(([id, connection]) => [id, {
        ...connection, values: emptyCanvasValues(connection.values),
      }])),
    }),
    pending: problem ?? t("results.playback.loading"),
  };

  const currentWindow = useEffectEvent(() => window ?? 0);
  const advance = useEffectEvent((next: number) => onWindowChange(next));

  useEffect(() => {
    if (!playing || !ready) return;
    const first = currentWindow();
    const start = performance.now();
    let previous = first;
    const timer = setInterval(() => {
      const next = Math.min(windowCount - 1, first + Math.floor((performance.now() - start) * speed * PLAYBACK_WINDOWS_PER_SECOND / 1000));
      if (next !== previous) {
        previous = next;
        advance(next);
      }
      if (next === windowCount - 1) setState({ key, playing: false });
    }, 40);
    return () => clearInterval(timer);
  }, [playing, ready, key, speed, windowCount]);

  const pause = () => setState({ key, playing: false });
  const seek = (next: number | null) => {
    pause();
    if (next === null) onWindowChange(null);
    else if (windowCount > 0) onWindowChange(Math.max(0, Math.min(windowCount - 1, Math.trunc(next))));
  };
  const play = () => {
    if (!enabled) return;
    if (window === null || window >= windowCount - 1) onWindowChange(0);
    setState({ key, playing: true });
  };
  return { frame, loading, problem, playing, speed, setSpeed, play, pause, seek };
}
