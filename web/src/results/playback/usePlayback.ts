import { t } from "../../i18n";
import { useEffect, useEffectEvent, useState } from "react";
import { emptyCanvasValues, windowCanvasResults, type CanvasResults } from "../canvasResults";
import { seriesLoader, type SeriesLoader } from "../series";
import { useConnectionSeries } from "../timeline/useConnectionSeries";
import { useTimelineSeries } from "../timeline/useTimelineSeries";

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

/** Browser time only advances the shared window; series alone determine every frame. */
export function usePlayback({
  runId, variant, pointId, replication, window, windowCount, nodes, results, onWindowChange,
}: PlaybackOptions, loader: Pick<SeriesLoader, "load"> & Partial<Pick<SeriesLoader, "loadConnections">> = seriesLoader) {
  const key = JSON.stringify([runId, variant, pointId, replication]);
  const [state, setState] = useState({ key, playing: false });
  const [speed, setSpeed] = useState(1);
  if (state.key !== key) setState({ key, playing: false });
  const enabled = variant !== null && results !== null && windowCount > 0;
  // Keep derived metrics to a working slice: at most 32 windows, using the artifact's 512-byte row estimate.
  const rangeSize = Math.max(1, Math.min(32, Math.floor(4 * 1024 * 1024 / (Math.max(1, nodes.length) * 512))));
  const fromWindow = Math.floor((window ?? 0) / rangeSize) * rangeSize;
  const untilWindow = Math.min(windowCount, fromWindow + rangeSize);
  const series = useTimelineSeries(loader, runId, enabled && window !== null ? variant : null,
    pointId, replication, nodes, untilWindow, fromWindow);
  const connections = [...(results?.connections ?? [])].filter(([, connection]) => connection.hasOwnSeries).map(([id]) => id);
  const connectionLoader = loader.loadConnections === undefined ? seriesLoader : loader as Pick<SeriesLoader, "loadConnections">;
  const connectionSeries = useConnectionSeries(connectionLoader, runId, enabled && window !== null && !series.loading ? variant : null,
    pointId, replication, connections, untilWindow, fromWindow);
  const loading = series.loading || connectionSeries.loading;
  const currentFrame = enabled && window !== null && !loading && series.problem === null && connectionSeries.problem === null
    ? windowCanvasResults(results!, series.nodes, window, fromWindow, connectionSeries.connections) : null;
  const problem = series.problem ?? connectionSeries.problem ?? (enabled && window !== null && !loading && currentFrame === null
    ? t("results.playback.missingWindow") : null);
  const playing = enabled && state.key === key && state.playing && problem === null;
  const ready = currentFrame !== null;
  const active = enabled && window !== null;
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

  const nodesKey = JSON.stringify(nodes);
  const connectionsKey = JSON.stringify(connections);
  const prefetchFrom = active && ready && window >= untilWindow - Math.min(8, rangeSize) && untilWindow < windowCount
    ? untilWindow : null;
  const prefetchUntil = prefetchFrom === null ? 0 : Math.min(windowCount, prefetchFrom + rangeSize);
  useEffect(() => {
    if (prefetchFrom === null || variant === null) return;
    const controller = new AbortController();
    const request = { runId, variant, cell: pointId, replication, fromWindow: prefetchFrom,
      untilWindow: prefetchUntil, signal: controller.signal };
    // Warm the existing bounded LRU; derived prefetch metrics are not retained.
    void Promise.all([
      loader.load({ ...request, nodes: JSON.parse(nodesKey) }),
      connectionsKey === "[]" ? Promise.resolve([])
        : connectionLoader.loadConnections({ ...request, connections: JSON.parse(connectionsKey) }),
    ]).catch(() => { /* The foreground load retries and reports speculative failures. */ });
    return () => controller.abort();
  }, [loader, connectionLoader, runId, variant, pointId, replication, nodesKey, connectionsKey, prefetchFrom, prefetchUntil]);
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
