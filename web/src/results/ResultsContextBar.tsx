import type { Catalog, ModelFile, RunSummary, Variant } from "../api/apiTypes";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";
import { utilizationColor, type ConnectionOverlayMetric, type NodeOverlayMetric } from "./canvasResults";
import { overlayOutputs, selectedOverlayOutput, type OverlayOutput } from "./outputs";
import { PlaybackControls } from "./playback/PlaybackControls";
import type { usePlayback } from "./playback/usePlayback";
import type { ResultsSelection } from "./selection";
import { pointLabel, variantLabel } from "../presentation/labels";

interface ResultsContextBarProps {
  catalog: Catalog;
  model: ModelFile;
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
  connectionMetric?: ConnectionOverlayMetric;
  onConnectionMetricChange?: (metric: ConnectionOverlayMetric) => void;
  stale: boolean;
  analysis: boolean;
  onAnalysisChange: () => void;
}

/** Controls the shared result context without changing documents or editor history. */
export function ResultsContextBar({ catalog, model, summary, variant, selection, onSelect, replications, playback,
  windowCount, windowMs, endMs, metric, onMetricChange, connectionMetric = "amplification", onConnectionMetricChange, stale, analysis, onAnalysisChange }: ResultsContextBarProps) {
  const points = [...new Map(summary.variants.flatMap(candidate => candidate.points).map(point => [point.id, point])).values()];
  const pointLabels = new Map(points.map(point => [point.id, pointLabel(point.id, summary.grid, point.coordinates, catalog, model)]));
  const name = variantLabel(variant, summary.variants);
  const selectedPoint = pointLabels.get(selection.pointId) ?? pointLabel(selection.pointId, summary.grid, undefined, catalog, model);
  const time = selection.window !== null;
  const context = time ? t("app.canvas.windowContext", {
    window: formatNumber(selection.window), start: formatDuration(selection.window! * windowMs),
    end: formatDuration(Math.min(endMs, (selection.window! + 1) * windowMs)), replication: formatNumber(selection.replication),
    variant: name, pointId: selectedPoint,
  }) : t("app.canvas.summaryContext", { variant: name, pointId: selectedPoint });
  const nodeOutputs = overlayOutputs(catalog, "BLOCK", model), connectionOutputs = overlayOutputs(catalog, "CONNECTION", model);
  const output = selectedOverlayOutput(nodeOutputs, metric);
  const connectionOutput = selectedOverlayOutput(connectionOutputs, connectionMetric);
  const optionLabel = (output: OverlayOutput, choices: readonly OverlayOutput[]) => choices.some(choice => choice.key !== output.key && choice.overlay!.title === output.overlay!.title)
    ? t("results.context.outputType", { metric: output.overlay!.title,
      types: output.types.map(id => catalog.types.find(type => type.id === id)?.title ?? id).join(", ") }) : output.overlay!.title;
  const metricLabel = output?.overlay?.scaleTitle ?? output?.overlay?.title ?? "";
  const limit = formatPercent(1);
  const minimum = formatPercent(0);
  return <div className="results-context-bar" role="region" aria-label={t("app.canvas.results")}
    data-testid="canvas-result-context" title={context}>
    <strong className="results-context-variant" title={name}>{name}</strong>
    {summary.grid.length === 0 ? null : <select aria-label={t("results.gridPoint")} title={selectedPoint}
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
    <span className="results-context-playback" aria-hidden={!time} inert={!time}>
      <PlaybackControls playback={playback} window={selection.window} windowCount={windowCount} disabled={!time || metric === "off"} />
      <span className="results-context-time" title={context}>{t("results.context.windowTime", {
        from: formatDuration(selection.window! * windowMs), to: formatDuration(Math.min(endMs, (selection.window! + 1) * windowMs)),
      })}</span>
    </span>
    <select aria-label={t("results.context.overlay")} title={output?.overlay?.title ?? t("results.context.metric.off")}
      value={output?.key ?? metric} onChange={event => onMetricChange(event.target.value as NodeOverlayMetric | "off")}>
      {nodeOutputs.map(output => <option key={output.key} value={output.key}>{optionLabel(output, nodeOutputs)}</option>)}
      <option value="off">{t("results.context.metric.off")}</option>
    </select>
    <select aria-label={t("results.context.connection.overlay")} title={t("results.context.connection.overlay")}
      value={connectionOutput?.key ?? connectionMetric} disabled={metric === "off"} onChange={event => onConnectionMetricChange?.(event.target.value as ConnectionOverlayMetric)}>
      {connectionOutputs.map(output => <option key={output.key} value={output.key}>{optionLabel(output, connectionOutputs)}</option>)}
    </select>
    {metric === "off" ? null : <>
      <span className="overlay-legend" aria-label={t("results.context.scale")} title={metricLabel}>
        <span className={output?.overlay?.scaleParameter != null ? undefined : "sr-only"}>{metricLabel}{t("results.context.legendSeparator")}</span>{minimum}{t("results.context.rangeSeparator")}{limit}
        <span className="overlay-scale" aria-hidden="true"
          style={{ background: `linear-gradient(90deg, ${utilizationColor(0)}, ${utilizationColor(0.5)}, ${utilizationColor(1)})` }} />
      </span>
      <span className="sr-only">{t("results.context.connection.legend", { metric: connectionOutput?.overlay?.title ?? connectionMetric })}</span>
    </>}
    {stale ? <span className="canvas-results-stale" role="status" title={t("app.canvas.stale")}>{t("app.canvas.stale")}</span> : null}
    <span className="results-context-actions">
      <button type="button" title={t("results.analysisHint")} aria-pressed={analysis} onClick={onAnalysisChange}>{t("results.analysis")}</button>
    </span>
  </div>;
}
