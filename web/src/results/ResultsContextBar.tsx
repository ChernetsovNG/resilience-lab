import type { RunSummary, Variant } from "../api/apiTypes";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";
import { utilizationColor, type NodeOverlayMetric } from "./canvasResults";
import { PlaybackControls } from "./playback/PlaybackControls";
import type { usePlayback } from "./playback/usePlayback";
import type { ResultsSelection } from "./selection";

interface ResultsContextBarProps {
  summary: RunSummary;
  variant: Variant;
  selection: ResultsSelection;
  onSelect: (change: Partial<ResultsSelection>) => void;
  replications: number;
  playback: ReturnType<typeof usePlayback>;
  windowCount: number;
  windowMs: number;
  endMs: number;
  metric: NodeOverlayMetric | "off";
  onMetricChange: (metric: NodeOverlayMetric | "off") => void;
  stale: boolean;
  analysis: boolean;
  onAnalysisChange: () => void;
}

/** Controls the shared result context without changing documents or editor history. */
export function ResultsContextBar({ summary, variant, selection, onSelect, replications, playback,
  windowCount, windowMs, endMs, metric, onMetricChange, stale, analysis, onAnalysisChange }: ResultsContextBarProps) {
  const points = [...new Map(summary.variants.flatMap(candidate => candidate.points).map(point => [point.id, point])).values()];
  const pointLabels = new Map(points.map(point => [point.id, Object.keys(point.coordinates).length === 0 ? point.id : t("results.gridPointCoordinates", {
    point: point.id, coordinates: Object.entries(point.coordinates).map(([path, value]) => t("results.coordinate", {
      path, value: typeof value === "number" ? formatNumber(value) : typeof value === "string" ? value : JSON.stringify(value),
    })).join(t("results.coordinateSeparator")),
  })]));
  const time = selection.window !== null;
  const context = time ? t("app.canvas.windowContext", {
    window: formatNumber(selection.window), start: formatNumber(selection.window! * windowMs, 1),
    end: formatDuration(Math.min(endMs, (selection.window! + 1) * windowMs)), replication: formatNumber(selection.replication),
    variant: variant.label ?? variant.id, pointId: selection.pointId,
  }) : t("app.canvas.summaryContext", { variant: variant.label ?? variant.id, pointId: selection.pointId });
  const metricLabel = metric === "off" ? "" : metric === "meanQueue" ? t("results.context.queueFill") : t(`results.context.metric.${metric}`);
  const limit = formatPercent(1);
  const minimum = formatPercent(0);
  return <div className="results-context-bar" role="region" aria-label={t("app.canvas.results")}
    data-testid="canvas-result-context" title={context}>
    <strong className="results-context-variant" title={variant.label ?? variant.id}>{variant.label ?? variant.id}</strong>
    {summary.grid.length === 0 ? null : <select aria-label={t("results.gridPoint")} title={pointLabels.get(selection.pointId) ?? selection.pointId}
      className="results-context-point" value={selection.pointId} onChange={event => onSelect({ pointId: event.target.value })}>
      {points.map(point => <option key={point.id} value={point.id}>
        {pointLabels.get(point.id)}
      </option>)}
    </select>}
    <label title={t("results.replication")}><span>{t("results.replication")}</span> <select aria-label={t("results.replication")} value={selection.replication}
      onChange={event => onSelect({ replication: Number(event.target.value) })}>
      {Array.from({ length: replications }, (_, index) => <option key={index} value={index}>{formatNumber(index)}</option>)}
    </select></label>
    <div className="results-context-mode" role="group" aria-label={t("results.context.mode")}>
      <button type="button" title={t("results.context.summary")} aria-pressed={!time} onClick={() => playback.seek(null)}>{t("results.context.summary")}</button>
      <button type="button" title={t("results.context.time")} aria-pressed={time} disabled={windowCount === 0}
        onClick={() => playback.seek(selection.window ?? 0)}>{t("results.context.time")}</button>
    </div>
    {time ? <>
      <PlaybackControls playback={playback} window={selection.window} windowCount={windowCount} disabled={metric === "off"} />
      <span className="results-context-time" title={context}>{t("results.context.windowTime", {
        from: formatNumber(selection.window! * windowMs, 1), to: formatDuration(Math.min(endMs, (selection.window! + 1) * windowMs)),
      })}</span>
    </> : null}
    <select aria-label={t("results.context.overlay")} title={t(`results.context.metric.${metric}`)}
      value={metric} onChange={event => onMetricChange(event.target.value as NodeOverlayMetric | "off")}>
      {(["utilization", "meanQueue", "queueRejectionRate", "off"] as const).map(value =>
        <option key={value} value={value}>{t(`results.context.metric.${value}`)}</option>)}
    </select>
    {metric === "off" ? null : <>
      <span className="overlay-legend" aria-label={t("results.context.scale")} title={metricLabel}>
        <span className={metric === "meanQueue" ? undefined : "sr-only"}>{metricLabel}{t("results.context.legendSeparator")}</span>{minimum}{t("results.context.rangeSeparator")}{limit}
        <span className="overlay-scale" aria-hidden="true"
          style={{ background: `linear-gradient(90deg, ${utilizationColor(0)}, ${utilizationColor(0.5)}, ${utilizationColor(1)})` }} />
      </span>
      <span className="sr-only">{t("results.context.edges")}</span>
    </>}
    {stale ? <span className="canvas-results-stale" role="status" title={t("app.canvas.stale")}>{t("app.canvas.stale")}</span> : null}
    <span className="results-context-actions">
      <button type="button" title={t("results.analysis")} aria-pressed={analysis} onClick={onAnalysisChange}>{t("results.analysis")}</button>
    </span>
  </div>;
}
