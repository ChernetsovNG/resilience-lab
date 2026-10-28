import { useMemo, useState } from "react";
import type { Catalog, ExperimentFile, ModelFile, RunManifest, RunSummary } from "../../api/apiTypes";
import { seriesLoader, type WindowMetricValues } from "../series";
import { timelineRegions } from "./data";
import { TimelineChart, type TimelineLine } from "./TimelineChart";
import { useTimelineSeries } from "./useTimelineSeries";

type MetricKey = Exclude<keyof WindowMetricValues, "startMs" | "durationMs" | "amplification">;
interface Metric { key: MetricKey; label: string; node?: "client" | "service" }
const groups: { title: string; unit: string; scale: number; metrics: Metric[] }[] = [
  { title: "Rates", unit: "RPS", scale: 1, metrics: [
    { key: "originalArrivalsPerSecond", label: "Original requests", node: "client" },
    { key: "offeredAttemptsPerSecond", label: "Offered attempts", node: "service" },
    { key: "admittedAttemptsPerSecond", label: "Admitted attempts", node: "service" },
    { key: "successesPerSecond", label: "Successes" },
    { key: "retriesPerSecond", label: "Retries", node: "service" },
  ] },
  { title: "Latency", unit: "ms", scale: 1, metrics: [
    { key: "meanLatencyMs", label: "Mean latency" }, { key: "p50LatencyMs", label: "p50 latency" },
    { key: "p95LatencyMs", label: "p95 latency" }, { key: "p99LatencyMs", label: "p99 latency" },
  ] },
  { title: "Errors and rejections", unit: "RPS", scale: 1, metrics: [
    { key: "failuresPerSecond", label: "Failures" }, { key: "timeoutsPerSecond", label: "Timeouts", node: "service" },
    { key: "queueRejectionsPerSecond", label: "Queue rejections", node: "service" },
  ] },
  { title: "Utilization", unit: "%", scale: 100, metrics: [{ key: "handlerUtilization", label: "Handler utilization", node: "service" }] },
  { title: "Queue", unit: "requests", scale: 1, metrics: [{ key: "meanQueueLength", label: "Mean queue", node: "service" }] },
];
const colors = ["#2563eb", "#b45309", "#047857", "#9333ea", "#be123c", "#0e7490"];

interface TimelineProps {
  enabled?: boolean;
  runId: string;
  summary: RunSummary;
  manifest: RunManifest;
  model: ModelFile;
  experiment: ExperimentFile;
  catalog: Catalog;
  activeVariantId: string | null;
  pointId: string;
  replication: number;
  cursorWindow: number | null;
  selectedNodes: readonly string[];
  onReplicationChange?: (replication: number) => void;
  onCursorChange?: (window: number | null) => void;
}

export function Timeline(props: TimelineProps) {
  // The key resets local node/metric/comparison choices when a different immutable run is displayed.
  return <RunTimeline key={props.runId} {...props} />;
}

function RunTimeline({ enabled = true, runId, summary, manifest, model, experiment, catalog, activeVariantId, pointId,
  replication, cursorWindow, selectedNodes, onReplicationChange, onCursorChange }: TimelineProps) {
  const canvasKey = JSON.stringify(selectedNodes);
  const availableNodes = Object.keys(model.blocks);
  const selectedFromCanvas = selectedNodes.filter((id) => Object.hasOwn(model.blocks, id));
  const initialNodes = selectedNodes.length > 0 ? selectedFromCanvas
    : [availableNodes.find((id) => model.blocks[id].type === "service") ?? availableNodes[0]].filter((id) => id !== undefined);
  const [nodeChoice, setNodeChoice] = useState({ canvasKey, ids: initialNodes });
  const nodes = nodeChoice.canvasKey === canvasKey ? nodeChoice.ids
    : selectedNodes.length > 0 ? selectedFromCanvas : nodeChoice.ids;
  if (nodeChoice.canvasKey !== canvasKey) setNodeChoice({ canvasKey, ids: nodes });
  const [metricKeys, setMetricKeys] = useState<MetricKey[]>(groups.flatMap((group) => group.metrics.map((metric) => metric.key)));
  const [comparison, setComparison] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const variant = activeVariantId === null ? summary.variants[0] : summary.variants.find((candidate) => candidate.id === activeVariantId);
  const compared = summary.variants.find((candidate) => candidate.id === comparison && candidate.id !== variant?.id);
  const metadata = manifest.series;
  const endMs = (metadata?.warmupMs ?? 0) + (metadata?.measurementMs ?? 0);
  const windowMs = metadata?.windowMs ?? 1;
  const count = Math.ceil(endMs / windowMs);
  const primary = useTimelineSeries(seriesLoader, runId, enabled && metadata ? variant?.id ?? null : null, pointId, replication, nodes, count);
  const overlay = useTimelineSeries(seriesLoader, runId, enabled && metadata ? compared?.id ?? null : null, pointId, replication, nodes, count);
  if (!enabled && hover !== null) setHover(null);
  const regions = useMemo(() => timelineRegions(metadata?.warmupMs ?? 0, metadata?.measurementMs ?? 0, experiment.faults, catalog),
    [metadata, experiment, catalog]);
  const charts = useMemo(() => groups.map((group) => {
    const lines: TimelineLine[] = [];
    for (const metric of group.metrics) {
      if (!metricKeys.includes(metric.key)) continue;
      for (const [nodeIndex, node] of primary.nodes.entries()) {
        if (metric.node !== undefined && metric.node !== model.blocks[node.id]?.type) continue;
        const color = colors[(nodeIndex * 3 + group.metrics.indexOf(metric)) % colors.length];
        for (const source of [{ variant, data: node, comparison: false }, {
          variant: compared, data: overlay.nodes.find((candidate) => candidate.id === node.id), comparison: true,
        }]) {
          if (source.variant === undefined || source.data === undefined) continue;
          lines.push({
            id: `${source.variant.id}:${node.id}:${metric.key}`, label: `${node.id} · ${metric.label} · ${source.variant.label ?? source.variant.id} (${source.variant.id})`,
            metric: metric.key, scale: group.scale, color, comparison: source.comparison, windows: source.data.windows,
          });
        }
      }
    }
    return { ...group, lines };
  }).filter((group) => group.lines.length > 0), [primary.nodes, overlay.nodes, model, metricKeys, variant, compared]);
  if (!enabled) return null;
  if (variant === undefined) return <p>The selected variant is not available in this run.</p>;
  if (metadata == null) return <p>Series metadata are unavailable for this run.</p>;
  const activeWindow = hover ?? cursorWindow;
  const onCursor = (window: number | null) => { setHover(null); onCursorChange?.(window); };
  return <div className="timeline">
    <div className="timeline-toolbar">
      <strong>{variant.label ?? variant.id} ({variant.id})</strong>
      <label>Replication <select aria-label="Replication" value={replication}
        onChange={(event) => { setHover(null); onReplicationChange?.(Number(event.target.value)); }}>
        {Array.from({ length: manifest.replications }, (_, index) => <option key={index} value={index}>{index}</option>)}
      </select></label>
      <label>Compare variant <select aria-label="Compare variant" value={compared?.id ?? ""}
        onChange={(event) => setComparison(event.target.value)}>
        <option value="">None</option>
        {summary.variants.filter((candidate) => candidate.id !== variant.id).map((candidate) =>
          <option key={candidate.id} value={candidate.id}>{candidate.label ?? candidate.id} ({candidate.id})</option>)}
      </select></label>
      <button type="button" onClick={() => onCursor(null)} disabled={cursorWindow === null}>Clear time cursor</button>
    </div>
    <details className="timeline-choices"><summary>Nodes and metrics</summary>
      <fieldset><legend>Nodes</legend>{availableNodes.map((id) => <label key={id}>
        <input type="checkbox" checked={nodes.includes(id)} onChange={(event) => setNodeChoice({ canvasKey,
          ids: event.target.checked ? [...nodes, id] : nodes.filter((node) => node !== id) })} />{id}
      </label>)}</fieldset>
      {groups.map((group) => <fieldset key={group.title}><legend>{group.title}</legend>{group.metrics.map((metric) =>
        <label key={metric.key}><input type="checkbox" checked={metricKeys.includes(metric.key)} onChange={(event) =>
          setMetricKeys(event.target.checked ? [...metricKeys, metric.key] : metricKeys.filter((key) => key !== metric.key))} />{metric.label}</label>)}</fieldset>)}
    </details>
    <div className="timeline-regions" aria-label="Time regions">
      {regions.map((region, index) => <span key={index} className={`timeline-region--${region.kind}`}>
        {region.label}: {region.fromMs}–{region.toMs} ms
      </span>)}
      <span>Solid: {variant.id}{compared === undefined ? "" : ` · dashed: ${compared.id}`}</span>
    </div>
    <p className="timeline-cursor" role="status" data-testid="timeline-cursor">
      {activeWindow === null ? "Hover to inspect windows; click to pin the time cursor."
        : `Window ${activeWindow} · ${activeWindow * windowMs}–${Math.min(endMs, (activeWindow + 1) * windowMs)} ms · replication ${replication}${hover === null && cursorWindow !== null ? " · pinned" : ""}`}
    </p>
    {primary.loading || overlay.loading ? <p role="status">Loading series…</p> : null}
    {primary.problem === null ? null : <p role="status">{primary.problem}</p>}
    {overlay.problem === null ? null : <p role="status">Comparison: {overlay.problem}</p>}
    {nodes.length === 0 ? <p>Select nodes from this run to see their series.</p> : null}
    {!primary.loading && primary.problem === null && nodes.length > 0 && charts.length === 0 ? <p>Select metrics to see their charts.</p> : null}
    <div className="timeline-charts">{charts.map((group) => <TimelineChart key={group.title} title={group.title} unit={group.unit}
      lines={group.lines} regions={regions} endMs={endMs} windowMs={windowMs} hoverWindow={hover} cursorWindow={cursorWindow}
      onHover={setHover} onCursor={onCursor} />)}</div>
  </div>;
}
