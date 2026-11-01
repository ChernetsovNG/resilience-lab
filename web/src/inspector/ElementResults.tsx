import { EntryResults } from "../results/EntryResults";
import { entryModels, hasEntryDetails, hasFallback, requestTypes } from "../results/entries";
import { applyOverrides, ownEntry } from "../workspace/params";
import type { Catalog, ExperimentFile, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { t } from "../i18n";
import { formatDuration, formatInterval, formatNumber } from "../i18n/format";
import { formatOutput, inspectorOutputs, outputNote, outputsOf, outputsUseTarget } from "../results/outputs";
import { seriesLoader } from "../results/series";
import { downsample, timelineRegions, type TimelinePoint, type TimelineRegion } from "../results/timeline/data";
import { useConnectionSeries } from "../results/timeline/useConnectionSeries";
import { useTimelineSeries } from "../results/timeline/useTimelineSeries";
import { projectElementResults, resultSelection, type ElementMetric } from "./elementResultsData";
import { confidenceInterval } from "../results/confidence";
import { useConfidenceLevel } from "../layout/confidenceLevel";
import { ReplicaResults } from "./ReplicaResults";
import { replicaMember } from "../results/groups";
import { pointLabel, variantLabel } from "../presentation/labels";
import { HelpHint } from "../help/HelpHint";

export interface ElementResultsProps {
  runId: string;
  summary: RunSummary;
  manifest: RunManifest;
  runModel: ModelFile;
  currentModel: ModelFile;
  experiment: ExperimentFile;
  catalog: Catalog;
  variantId: string;
  pointId: string;
  replication: number;
  window: number | null;
  selected: string | null;
  onShowTimeline: () => void;
  onSelectReplica?: (id: string) => void;
}

type Format = (value: number | null | undefined) => string;
function MiniChart({ element, title, points, format, replication, regions, endMs, cursorWindow, windowMs, thresholdMs = null }: {
  element: string; title: string; points: TimelinePoint[]; format: Format; replication: number;
  regions: TimelineRegion[]; endMs: number; cursorWindow: number | null; windowMs: number; thresholdMs?: number | null;
}) {
  const sampled = downsample(points, 300);
  const maximum = Math.max(0, thresholdMs ?? 0, ...sampled.map(point => point.value ?? 0));
  const x = (time: number) => 8 + Math.max(0, Math.min(1, time / (endMs || 1))) * 304;
  const y = (value: number) => 88 - value / (maximum || 1) * 66;
  const path = sampled.map((point, index) => point.value === null ? ""
    : `${index > 0 && sampled[index - 1].value !== null ? "L" : "M"}${x(point.startMs)},${y(point.value)}`).join(" ");
  const label = t("inspector.results.chart", { element, metric: title, replication: formatNumber(replication) });
  return <figure className="element-results-chart">
    <figcaption>{title}</figcaption>
    <svg viewBox="0 0 320 110" role="img" aria-label={label}>
      <title>{label}</title>
      {regions.map((region, index) => <rect key={index} data-region={region.kind}
        x={x(region.fromMs)} width={Math.max(0, x(region.toMs) - x(region.fromMs))} y="22" height="66"
        fill={region.kind === "fault" ? "#df8a22" : "#8290a0"} opacity="0.18"><title>{region.label}</title></rect>)}
      <line x1="8" x2="312" y1="88" y2="88" stroke="currentColor" opacity="0.25" />
      <text x="8" y="14">{format(maximum)}</text>
      {thresholdMs === null ? null : <g>
        <line data-threshold-ms={thresholdMs} x1="8" x2="312" y1={y(thresholdMs)} y2={y(thresholdMs)} stroke="#b8443e" strokeDasharray="4 3">
          <title>{t("inspector.results.chartLine", { metric: t("inspector.results.timeout"), value: formatDuration(thresholdMs) })}</title>
        </line>
        <text x="312" y={Math.max(18, y(thresholdMs) - 3)} textAnchor="end">{t("inspector.results.timeout")}</text>
      </g>}
      <path d={path} fill="none" stroke="var(--accent, #287fad)" strokeWidth="1.8" />
      {sampled.filter(point => point.value !== null).map(point => <circle key={point.window}
        cx={x(point.startMs)} cy={y(point.value!)} r="1.6" fill="var(--accent, #287fad)">
        <title>{t("inspector.results.chartLine", { metric: title, value: format(point.value) })}</title>
      </circle>)}
      {cursorWindow === null ? null : <line data-testid="mini-cursor" data-cursor-window={cursorWindow}
        x1={x(cursorWindow * windowMs)} x2={x(cursorWindow * windowMs)} y1="22" y2="88" stroke="currentColor" strokeWidth="1.5">
        <title>{t("results.timeline.timeCursor", { title })}</title>
      </line>}
      <text x="8" y="105">{formatDuration(0)}</text><text x="312" y="105" textAnchor="end">{formatDuration(endMs)}</text>
    </svg>
    {sampled.some(point => point.value !== null) ? null : <p>{t("inspector.results.chartEmpty")}</p>}
  </figure>;
}

/** Selected-element output uses the same immutable run context and bounded loader cache as Timeline and playback. */
export function ElementResults(props: ElementResultsProps) {
  const level = useConfidenceLevel();
  const { runId, summary, manifest, runModel, currentModel, experiment, catalog, variantId, pointId, replication, window, selected, onShowTimeline } = props;
  const initial = projectElementResults(props);
  const point = summary.variants.find(variant => variant.id === variantId)?.points.find(point => point.id === pointId);
  const selection = resultSelection(runModel, currentModel, selected, point?.aggregate.groups);
  const memberGroup = selected === null ? undefined : replicaMember(point?.aggregate.groups ?? [], selected)?.group;
  const group = point?.aggregate.groups.find(group => group.kind === "NODE" && group.id === selected)
    ?? (memberGroup?.kind === "NODE" ? memberGroup : undefined);
  const metadata = manifest.series;
  const endMs = (metadata?.warmupMs ?? 0) + (metadata?.measurementMs ?? 0);
  const windowMs = metadata?.windowMs ?? 1;
  const count = Math.ceil(endMs / windowMs);
  const enabled = initial !== null && manifest.complete && metadata != null;
  const needsTarget = selection?.category === "CONNECTION" && (window !== null
    || outputsUseTarget(inspectorOutputs(outputsOf(catalog, selection.kind), true)));
  const nodeIds = selection?.category === "BLOCK" ? [selection.id] : needsTarget ? [selection.target!] : [];
  if (selection?.kind === "request" && window !== null) nodeIds.push(selection.source!);
  const primary = useTimelineSeries(seriesLoader, runId, enabled ? variantId : null, pointId, replication, nodeIds, count);
  const replicas = useTimelineSeries(seriesLoader, runId, enabled && window !== null && group !== undefined ? variantId : null,
    pointId, replication, group?.instances.map(instance => instance.id) ?? [], (window ?? 0) + 1, window ?? 0);
  const calls = useConnectionSeries(seriesLoader, runId, enabled && selection?.category === "CONNECTION" && selection.kind !== "request" ? variantId : null,
    pointId, replication, selection?.category === "CONNECTION" ? [selection.id] : [], count);
  const result = projectElementResults({ ...props, nodes: primary.nodes, connections: calls.connections });
  const regions = timelineRegions(metadata?.warmupMs ?? 0, metadata?.measurementMs ?? 0, experiment.faults, catalog);
  const variant = summary.variants.find(variant => variant.id === variantId);
  const intervalFor = (metric: ElementMetric) => confidenceInterval({ mean: metric.value, stdDev: metric.stdDev, count: metric.count }, level);
  const sourceLabel = (metric: ElementMetric) => metric.source === "window"
    ? t("inspector.results.window", { window: formatNumber(window) }) : metric.source === "replication"
      ? t("inspector.results.replication", { replication: formatNumber(replication) }) : t(`inspector.results.${metric.source}`);
  const charts = inspectorOutputs(result?.outputs ?? [], true).map(output => ({
    id: output.id,
    title: output.inspector!.title, format: (value: number | null | undefined) => formatOutput(output, value),
    thresholdMs: output.inspector!.thresholdParameter == null ? null : result?.timeoutMs,
    points: (result?.windows ?? []).map((frame, index) => ({ window: index, startMs: frame.startMs, value: frame[output.id] })),
  }));
  if (selection?.kind === "client" && point !== undefined && variant !== undefined && manifest.complete
    && replication >= 0 && replication < variant.replications) {
    const entry = ownEntry(point.aggregate.entries.clients, selection.id);
    const effective = applyOverrides(applyOverrides(runModel,
      experiment.variants.find(variant => variant.id === variantId)?.overrides ?? {}, catalog), point.coordinates, catalog);
    const client = ownEntry(effective.blocks, selection.id);
    const aggregates = summary.variants.flatMap(variant => variant.points.map(point => point.aggregate));
    const models = entryModels(summary, runModel, catalog, experiment.variants);
    const showFailures = hasEntryDetails(aggregates, models);
    const showDegraded = hasFallback(aggregates, models);
    const types = client !== undefined && Array.isArray(client.params.classes) ? requestTypes(client.params) : [];
    return <section className="element-results" aria-label={t("inspector.results.title")}>
      <h3>{t("inspector.results.title")}</h3>
      {entry === undefined ? <p>{t("inspector.results.unavailable")}</p> : <>
        <p className="element-results-context">{t("results.entries.context", { variant: variantLabel(variant, experiment.variants), point: pointLabel(pointId, summary.grid, point.coordinates, catalog, runModel) })}</p>
        <p className="element-results-note">{t("results.entries.summaryNote")}</p>
        <EntryResults entry={entry} name={t("inspector.results.title")} showFailures={showFailures} showDegraded={showDegraded} />
        {window === null || result === null ? null : <table aria-label={t("inspector.results.window", { window: formatNumber(window) })}><tbody>
          {inspectorOutputs(result.outputs).map(output => <tr key={output.id}>
            <th scope="row">{output.inspector!.title}</th>
            <td>{formatOutput(output, result.values[output.id]?.value)}<small>{t("inspector.results.window", { window: formatNumber(window) })}</small></td>
          </tr>)}
        </tbody></table>}
        {types.length === 0 ? null : <section aria-label={t("results.entries.byRequestTypes")}>
          <h4>{t("results.entries.byRequestTypes")}</h4>
          {types.some(id => Object.values(effective.blocks).filter(block => block.type === "client" && requestTypes(block.params).includes(id)).length > 1)
            ? <p className="element-results-note">{t("results.entries.sharedTypes")}</p> : null}
          {types.map(id => <div key={id}><h4>{id}</h4><EntryResults entry={ownEntry(point.aggregate.entries.classes, id)}
            name={t("results.entries.requestType", { id })} showFailures={showFailures} showDegraded={showDegraded} /></div>)}
        </section>}
        <button type="button" onClick={onShowTimeline}>{t("inspector.results.showTimeline")}</button>
      </>}
    </section>;
  }
  return <section className="element-results" aria-label={t("inspector.results.title")}>
    <h3>{t("inspector.results.title")}</h3>
    {selected === null ? <p>{t("inspector.results.select")}</p> : result === null || !manifest.complete
      ? <p>{t("inspector.results.unavailable")}</p> : <>
        <p className="element-results-context">{t("inspector.results.context", { variant: variantLabel(variant, experiment.variants),
          point: pointLabel(pointId, summary.grid, variant?.points.find(point => point.id === pointId)?.coordinates, catalog, runModel),
          replication: formatNumber(replication), mode: t(window === null ? "inspector.results.summaryMode" : "inspector.results.timeMode") })}</p>
        {group === undefined || point === undefined ? null : <ReplicaResults key={group.id} group={group} aggregate={point.aggregate}
          catalog={catalog} replications={variant?.replications ?? 0} models={entryModels(summary, runModel, catalog, experiment.variants)}
          window={window} frames={new Map(replicas.nodes.map(node => [node.id, node.windows[0]]))}
          selected={selected} onSelect={props.onSelectReplica} />}
        <table aria-label={t("inspector.results.title")}><tbody>
          {inspectorOutputs(result.outputs).map(output => {
            const key = output.id, label = output.inspector!.title;
            const format = (value: number | null | undefined) => formatOutput(output, value);
            const value = result.values[key];
            const interval = intervalFor(value);
            const note = outputNote(output, value.value, result.amplificationUnavailableReason);
            return <tr key={key}><th scope="row">{label}</th><td>{format(value.value)}
              {output.id === "amplification" || output.id === "attemptsPerCall" ? <HelpHint label={label}>{output.description}</HelpHint> : null}
              {interval === null ? null : <span className={`summary-interval${(value.count ?? 0) < 5 ? " summary-interval--unreliable" : ""}`}>
                {t("results.intervalInParens", { interval: formatInterval(interval[0], interval[1], format, level) })}
              </span>}
              <small>{sourceLabel(value)}</small>
              {note === null || (window !== null && primary.loading) ? null : <small className="output-note">{note}</small>}
              {value.approximate ? <small title={t("editor.canvas.amplificationWindowTitle")}>{t("inspector.results.approximate")}</small> : null}
            </td></tr>;
          })}
          {result.timeoutMs !== null ? <tr><th scope="row">{t("inspector.results.timeout")}</th><td>{formatDuration(result.timeoutMs)}</td></tr> : null}
        </tbody></table>
        {window === null && Object.values(result.values).some(value => (value.count ?? 0) < 5 && intervalFor(value) !== null)
          ? <p className="summary-reliability-warning">{t("results.answer.lowReplications")}</p> : null}
        {window === null && result.latencyCoverage !== undefined ? <p className="element-results-note">{t("inspector.results.coveredLatency", {
          from: formatDuration(result.latencyCoverage.fromMs), to: formatDuration(result.latencyCoverage.toMs),
        })}</p> : null}
        {result.outputs.some(output => output.inspector?.thresholdParameter != null) ? <p className="element-results-note">{t("inspector.results.latencyNote")}</p> : null}
        {primary.loading || calls.loading || replicas.loading ? <p role="status">{t("inspector.results.loading")}</p> : null}
        {primary.problem === null ? null : <p role="status">{primary.problem}</p>}
        {calls.problem === null ? null : <p role="status">{calls.problem}</p>}
        {replicas.problem === null ? null : <p role="status">{replicas.problem}</p>}
        {metadata == null ? <p>{t("results.timeline.metadataUnavailable")}</p> : <div className="element-results-charts">
          {charts.map(chart => <MiniChart key={chart.id} {...chart} element={result.id} replication={replication} regions={regions}
            endMs={endMs} windowMs={windowMs} cursorWindow={window} />)}
        </div>}
        <button type="button" onClick={onShowTimeline}>{t("inspector.results.showTimeline")}</button>
        <details><summary>{t("results.assumptions.title")}</summary><ul>
          {catalog.types.find(type => type.id === result.kind)?.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}
        </ul></details>
      </>}
  </section>;
}
