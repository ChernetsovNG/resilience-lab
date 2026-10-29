import { t } from "../../i18n";
import { TimelineGrid } from "./TimelineGrid";
import { formatDuration, formatNumber } from "../../i18n/format";
import { useMemo, useState } from "react";
import type { Catalog, ExperimentFile, ModelFile, RunManifest, RunSummary } from "../../api/apiTypes";
import { seriesLoader } from "../series";
import { connectionTimelineWindow, timelineRegions, type TimelineMetricValues } from "./data";
import { TimelineChart, type TimelineLine, type TimelineThreshold } from "./TimelineChart";
import { useTimelineSeries } from "./useTimelineSeries";
import { useConnectionSeries } from "./useConnectionSeries";
import { applyOverrides } from "../../workspace/params";
import { canonicalOf } from "../../workspace/quantities";

type MetricKey = Exclude<keyof TimelineMetricValues, "startMs" | "durationMs" | "amplification">;
interface Metric { key: MetricKey; label: string; nodes?: readonly ("client" | "service" | "call")[] }
const groups: { title: string; unit: string; scale: number; metrics: Metric[] }[] = [
  { title: t("results.timeline.rates"), unit: "RPS", scale: 1, metrics: [
    { key: "sentAttemptsPerSecond", label: t("results.timeline.sentAttempts"), nodes: ["call"] },
    { key: "originalArrivalsPerSecond", label: t("results.metrics.originalRequests"), nodes: ["client"] },
    { key: "offeredAttemptsPerSecond", label: t("results.metrics.offeredAttempts"), nodes: ["service"] },
    { key: "admittedAttemptsPerSecond", label: t("results.metrics.admittedAttempts"), nodes: ["service"] },
    { key: "successesPerSecond", label: t("results.metrics.successes") },
    { key: "retriesPerSecond", label: t("results.metrics.retries"), nodes: ["service", "call"] },
  ] },
  { title: t("results.timeline.latency"), unit: "ms", scale: 1, metrics: [
    { key: "meanLatencyMs", label: t("results.metrics.meanLatencyMs") }, { key: "p50LatencyMs", label: t("results.metrics.p50LatencyMs") },
    { key: "p95LatencyMs", label: t("results.metrics.p95LatencyMs") }, { key: "p99LatencyMs", label: t("results.metrics.p99LatencyMs") },
  ] },
  { title: t("results.timeline.errors"), unit: "RPS", scale: 1, metrics: [
    { key: "failuresPerSecond", label: t("results.metrics.failures") }, { key: "timeoutsPerSecond", label: t("results.metrics.timeouts"), nodes: ["service", "call"] },
    { key: "orphanedPerSecond", label: t("results.timeline.orphanedAttempts"), nodes: ["call"] },
    { key: "queueRejectionsPerSecond", label: t("results.metrics.queueRejections"), nodes: ["service"] },
  ] },
  { title: t("results.timeline.utilization"), unit: "%", scale: 100, metrics: [{ key: "handlerUtilization", label: t("results.metrics.handlerUtilization"), nodes: ["service"] }] },
  { title: t("results.timeline.callState"), unit: "requests", scale: 1, metrics: [
    { key: "meanInFlight", label: t("results.timeline.meanInFlight"), nodes: ["call"] },
    { key: "meanOrphaned", label: t("results.timeline.meanOrphaned"), nodes: ["call"] },
    { key: "meanBackoff", label: t("results.timeline.meanBackoff"), nodes: ["call"] },
  ] },
  { title: t("results.timeline.queue"), unit: "requests", scale: 1, metrics: [{ key: "meanQueueLength", label: t("results.metrics.meanQueue"), nodes: ["service"] }] },
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
  selectionRequest?: number;
  onCursorChange?: (window: number | null) => void;
}

export function Timeline(props: TimelineProps) {
  // The key resets local node/metric/comparison choices when a different immutable run is displayed.
  return <RunTimeline key={JSON.stringify([props.runId, props.selectionRequest ?? 0])} {...props} />;
}

function RunTimeline({ enabled = true, runId, summary, manifest, model, experiment, catalog, activeVariantId, pointId,
  replication, cursorWindow, selectedNodes, onCursorChange }: TimelineProps) {
  const canvasKey = JSON.stringify(selectedNodes);
  const availableConnections = model.connections.filter((connection) => connection.type === "call").map((connection) => connection.id);
  const availableNodes = [...Object.keys(model.blocks), ...availableConnections];
  const selectedFromCanvas = selectedNodes.filter((id) => availableNodes.includes(id));
  const initialNodes = selectedNodes.length > 0 ? selectedFromCanvas
    : [availableNodes.find((id) => model.blocks[id]?.type === "service") ?? availableNodes[0]].filter((id) => id !== undefined);
  const [nodeChoice, setNodeChoice] = useState({ canvasKey, ids: initialNodes });
  const nodes = nodeChoice.canvasKey === canvasKey ? nodeChoice.ids
    : selectedNodes.length > 0 ? selectedFromCanvas : nodeChoice.ids;
  if (nodeChoice.canvasKey !== canvasKey) setNodeChoice({ canvasKey, ids: nodes });
  const [metricKeys, setMetricKeys] = useState<MetricKey[]>(groups.flatMap((group) => group.metrics.map((metric) => metric.key)));
  const [comparison, setComparison] = useState("");
  const variant = activeVariantId === null ? summary.variants[0] : summary.variants.find((candidate) => candidate.id === activeVariantId);
  const context = JSON.stringify([variant?.id, pointId, replication, cursorWindow]);
  const [inspection, setInspection] = useState({ context, window: null as number | null });
  const hover = inspection.context === context ? inspection.window : null;
  if (inspection.context !== context) setInspection({ context, window: null });
  const setHover = (window: number | null) => setInspection({ context, window });
  const compared = summary.variants.find((candidate) => candidate.id === comparison && candidate.id !== variant?.id);
  const metadata = manifest.series;
  const endMs = (metadata?.warmupMs ?? 0) + (metadata?.measurementMs ?? 0);
  const windowMs = metadata?.windowMs ?? 1;
  const count = Math.ceil(endMs / windowMs);
  const nodeIds = nodes.filter((id) => Object.hasOwn(model.blocks, id));
  const connectionIds = nodes.filter((id) => availableConnections.includes(id));
  const primary = useTimelineSeries(seriesLoader, runId, enabled && metadata ? variant?.id ?? null : null, pointId, replication, nodeIds, count);
  const overlay = useTimelineSeries(seriesLoader, runId, enabled && metadata ? compared?.id ?? null : null, pointId, replication, nodeIds, count);
  // Node loads may decode mixed parts that the connection load can then reuse.
  const primaryConnections = useConnectionSeries(seriesLoader, runId,
    enabled && metadata && !primary.loading ? variant?.id ?? null : null, pointId, replication, connectionIds, count);
  const overlayConnections = useConnectionSeries(seriesLoader, runId,
    enabled && metadata && !overlay.loading ? compared?.id ?? null : null, pointId, replication, connectionIds, count);
  if (!enabled && hover !== null) setHover(null);
  const regions = useMemo(() => timelineRegions(metadata?.warmupMs ?? 0, metadata?.measurementMs ?? 0, experiment.faults, catalog),
    [metadata, experiment, catalog]);
  const charts = useMemo(() => {
    const connectionSeries = primaryConnections.connections.map((connection) => ({
      id: connection.id, windows: connection.windows.map(connectionTimelineWindow),
    }));
    const comparedConnectionSeries = overlayConnections.connections.map((connection) => ({
      id: connection.id, windows: connection.windows.map(connectionTimelineWindow),
    }));
    return groups.map((group) => {
      const lines: TimelineLine[] = [];
      for (const metric of group.metrics) {
        if (!metricKeys.includes(metric.key)) continue;
        for (const [nodeIndex, node] of primary.nodes.entries()) {
          if (metric.nodes !== undefined && !metric.nodes.some((type) => type === model.blocks[node.id]?.type)) continue;
          const color = colors[(nodeIndex * 3 + group.metrics.indexOf(metric)) % colors.length];
          for (const source of [{ variant, data: node, comparison: false }, {
            variant: compared, data: overlay.nodes.find((candidate) => candidate.id === node.id), comparison: true,
          }]) {
            if (source.variant === undefined || source.data === undefined) continue;
            lines.push({
              id: `${source.variant.id}:${node.id}:${metric.key}`, label: t("results.timeline.lineLabel", { node: node.id, metric: metric.label, variant: source.variant.label ?? source.variant.id, id: source.variant.id }),
              metric: metric.key, scale: group.scale, color, comparison: source.comparison, windows: source.data.windows,
            });
          }
        }
        if (metric.nodes !== undefined && !metric.nodes.includes("call")) continue;
        for (const [connectionIndex, connection] of connectionSeries.entries()) {
          const color = colors[((primary.nodes.length + connectionIndex) * 3 + group.metrics.indexOf(metric)) % colors.length];
          for (const source of [{ variant, data: connection, comparison: false }, {
            variant: compared, data: comparedConnectionSeries.find((candidate) => candidate.id === connection.id), comparison: true,
          }]) {
            if (source.variant === undefined || source.data === undefined) continue;
            const label = source.comparison
              ? t("results.timeline.connectionComparisonLabel", { connection: connection.id, metric: metric.label, variant: source.variant.id })
              : t("results.timeline.connectionLineLabel", { connection: connection.id, metric: metric.label });
            lines.push({ id: `${source.variant.id}:${connection.id}:${metric.key}`, label,
              metric: metric.key, scale: group.scale, color, comparison: source.comparison,
              windows: source.data.windows });
          }
        }
      }
      return { ...group, lines };
    }).filter((group) => group.lines.length > 0);
  }, [primary.nodes, overlay.nodes, primaryConnections.connections,
    overlayConnections.connections, model, metricKeys, variant, compared]);
  const thresholds: TimelineThreshold[] = [variant, compared].flatMap((source, index) => {
    if (source === undefined) return [];
    const point = source.points.find((candidate) => candidate.id === pointId);
    const runVariant = experiment.variants.find((candidate) => candidate.id === source.id);
    if (point === undefined || runVariant === undefined) return [];
    const effective = applyOverrides(applyOverrides(model, runVariant.overrides, catalog), point.coordinates, catalog);
    return effective.connections.flatMap((connection) => {
      if (!connectionIds.includes(connection.id) || connection.type !== "call") return [];
      const descriptor = catalog.types.find((type) => type.id === connection.type)?.params.find((param) => param.name === "timeout");
      const timeout = connection.params.timeout ?? descriptor?.default;
      const value = typeof timeout === "string" ? canonicalOf(timeout, descriptor?.units ?? []) : null;
      return value === null ? [] : [{ id: `${source.id}:${connection.id}:timeout`, value, comparison: index === 1,
        label: t("results.timeline.timeout", { connection: connection.id, variant: source.label ?? source.id, id: source.id }) }];
    });
  });
  if (!enabled) return null;
  if (variant === undefined) return <p>{t("results.timeline.variantUnavailable")}</p>;
  if (metadata == null) return <p>{t("results.timeline.metadataUnavailable")}</p>;
  const activeWindow = hover ?? cursorWindow;
  const onCursor = (window: number | null) => { setHover(null); onCursorChange?.(window); };
  return <div className="timeline">
    <div className="timeline-toolbar">
      <strong>{t("results.timeline.variantLabel", { variant: variant.label ?? variant.id, id: variant.id })}</strong>
      <label>{t("results.timeline.compare")} <select aria-label={t("results.timeline.compare")} value={compared?.id ?? ""}
        onChange={(event) => setComparison(event.target.value)}>
        <option value="">{t("results.timeline.noComparison")}</option>
        {summary.variants.filter((candidate) => candidate.id !== variant.id).map((candidate) =>
          <option key={candidate.id} value={candidate.id}>{t("results.timeline.variantLabel", { variant: candidate.label ?? candidate.id, id: candidate.id })}</option>)}
      </select></label>
    </div>
    <details className="timeline-choices"><summary>{t("results.timeline.choices")}</summary>
      <fieldset><legend>{t("results.timeline.nodes")}</legend>{availableNodes.map((id) => <label key={id}>
        <input type="checkbox" checked={nodes.includes(id)} onChange={(event) => setNodeChoice({ canvasKey,
          ids: event.target.checked ? [...nodes, id] : nodes.filter((node) => node !== id) })} />{id}
      </label>)}</fieldset>
      {groups.map((group) => <fieldset key={group.title}><legend>{group.title}</legend>{group.metrics.map((metric) =>
        <label key={metric.key}><input type="checkbox" checked={metricKeys.includes(metric.key)} onChange={(event) =>
          setMetricKeys(event.target.checked ? [...metricKeys, metric.key] : metricKeys.filter((key) => key !== metric.key))} />{metric.label}</label>)}</fieldset>)}
    </details>
    <div className="timeline-regions" aria-label={t("results.timeline.regions")}>
      {regions.map((region, index) => <span key={index} className={`timeline-region--${region.kind}`}>
        {t("results.timeline.region", { label: region.label, from: formatNumber(region.fromMs, 1), to: formatDuration(region.toMs) })}
      </span>)}
      <span>{t("results.timeline.solid", { variant: variant.id, comparison: compared === undefined ? "" : t("results.timeline.dashed", { variant: compared.id }) })}</span>
    </div>
    <p className="timeline-cursor" role="status" data-testid="timeline-cursor">
      {activeWindow === null ? t("results.timeline.inspect")
        : t("results.timeline.window", {
          window: formatNumber(activeWindow), from: formatNumber(activeWindow * windowMs, 1),
          to: formatDuration(Math.min(endMs, (activeWindow + 1) * windowMs)), replication: formatNumber(replication),
          pinned: hover === null && cursorWindow !== null ? t("results.timeline.pinned") : "",
        })}
    </p>
    {primary.loading || overlay.loading || primaryConnections.loading || overlayConnections.loading ? <p role="status">{t("results.timeline.loadingSeries")}</p> : null}
    {primary.problem === null ? null : <p role="status">{primary.problem}</p>}
    {overlay.problem === null ? null : <p role="status">{t("results.timeline.comparisonProblem", { problem: overlay.problem })}</p>}
    {primaryConnections.problem === null ? null : <p role="status">{primaryConnections.problem}</p>}
    {overlayConnections.problem === null ? null : <p role="status">{t("results.timeline.comparisonProblem", { problem: overlayConnections.problem })}</p>}
    {connectionIds.length > 0 ? <p className="timeline-latency-note">{t("results.timeline.connectionLegend")}</p> : null}
    {nodes.length === 0 ? <p>{t("results.timeline.selectNodes")}</p> : null}
    {!primary.loading && !primaryConnections.loading && primary.problem === null && primaryConnections.problem === null && nodes.length > 0 && charts.length === 0 ? <p>{t("results.timeline.selectMetrics")}</p> : null}
    <TimelineGrid>{charts.map((group) => <TimelineChart key={group.title} title={group.title} unit={group.unit}
      lines={group.lines} regions={regions} thresholds={group.unit === "ms" ? thresholds : undefined} endMs={endMs} windowMs={windowMs} hoverWindow={hover} cursorWindow={cursorWindow}
      onHover={setHover} onCursor={onCursor} />)}</TimelineGrid>
  </div>;
}
