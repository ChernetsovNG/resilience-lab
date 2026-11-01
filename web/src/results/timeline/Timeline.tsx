import { t } from "../../i18n";
import { TimelineGrid } from "./TimelineGrid";
import { formatDuration, formatNumber } from "../../i18n/format";
import { useMemo, useState } from "react";
import type { Catalog, ExperimentFile, ModelFile, OutputDescriptor, RunManifest, RunSummary } from "../../api/apiTypes";
import { seriesLoader, type NodeSeriesMetrics, type DecodedConnectionWindow, type SeriesLoadRequest } from "../series";
import { timelineRegions } from "./data";
import { outputsOf, outputsUseTarget, outputWindow, timelineGroups } from "../outputs";
import { TimelineChart, type TimelineLine, type TimelineThreshold, type TimelineStateBand } from "./TimelineChart";
import { useTimelineSeries } from "./useTimelineSeries";
import { useConnectionSeries } from "./useConnectionSeries";
import { applyOverrides } from "../../workspace/params";
import { canonicalOf } from "../../workspace/quantities";
import { elementLabel, variantLabel } from "../../presentation/labels";
import { policyOutputAvailable, poolOutputAvailable } from "../../workspace/policyParameters";
import { requestTypes } from "../entries";
import { replicaMember } from "../groups";
import { policyWindowState, type PolicyState } from "../policyState";

const colors = ["#2563eb", "#b45309", "#047857", "#9333ea", "#be123c", "#0e7490"];
const metricChoiceKey = (element: string, metric: string) => JSON.stringify([element, metric]);
const requestTypeKey = (id: string) => JSON.stringify(["classes", id]);
const classSeriesLoader = { load: ({ nodes, ...request }: SeriesLoadRequest) => seriesLoader.loadClasses({ ...request, classes: nodes }) };

function replicaRange(outputs: readonly OutputDescriptor[], metric: string): readonly [string, string] | undefined {
  const output = outputs.find(output => output.id === metric);
  const pool = /^slotPools\.([^.]+)\./.exec(output?.calculation.field ?? "")?.[1];
  const quantity = output?.kind === "UTILIZATION" ? "Utilization"
    : output?.calculation.field?.endsWith(".queueIntegralMs") ? "MeanQueueLength" : null;
  if (pool === undefined || quantity === null) return;
  const extreme = (bound: string) => outputs.find(output =>
    output.calculation.field === `slotPools.${pool}.replicaExtrema.${bound}${quantity}`)?.id;
  const min = extreme("min"), max = extreme("max");
  return min === undefined || max === undefined ? undefined : [min, max];
}

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
  const variant = activeVariantId === null ? summary.variants[0] : summary.variants.find((candidate) => candidate.id === activeVariantId);
  const replicaGroups = useMemo(() => variant?.points.find(point => point.id === pointId)?.aggregate.groups ?? [], [variant, pointId]);
  const originals = useMemo(() => new Map(replicaGroups.flatMap(group => group.instances.map(instance => [instance.id, group.id]))), [replicaGroups]);
  const groups = useMemo(() => timelineGroups(catalog), [catalog]);
  const [comparison, setComparison] = useState("");
  const compared = summary.variants.find((candidate) => candidate.id === comparison && candidate.id !== variant?.id);
  const displayedModels = useMemo(() => [variant, compared].flatMap(source => source === undefined ? [] : [
    applyOverrides(applyOverrides(model, experiment.variants.find(variant => variant.id === source.id)?.overrides ?? {}, catalog),
      source.points.find(point => point.id === pointId)?.coordinates ?? {}, catalog),
  ]), [variant, compared, model, experiment.variants, catalog, pointId]);
  const policyModels = useMemo(() => experiment.variants.flatMap(variant => {
    const effective = applyOverrides(model, variant.overrides, catalog);
    const points = summary.variants.find(source => source.id === variant.id)?.points ?? [];
    return points.length === 0 ? [effective] : points.map(point => applyOverrides(effective, point.coordinates, catalog));
  }), [model, experiment.variants, summary.variants, catalog]);
  const elements = useMemo(() => {
    const definitions = [
      ...Object.entries(model.blocks).map(([id, block]) => ({ id, type: block.type, requestType: null as string | null })),
      ...model.connections.map(({ id, type }) => ({ id, type, requestType: null as string | null })),
    ];
    const clients = policyModels.flatMap(effective => Object.values(effective.blocks).filter(block => block.type === "client"));
    const types = clients.some(block => Array.isArray(block.params.classes))
      ? [...new Set(clients.flatMap(block => requestTypes(block.params)))] : [];
    definitions.splice(definitions.map(element => element.type).lastIndexOf("client") + 1, 0,
      ...types.map(id => ({ id: requestTypeKey(id), type: "client", requestType: id })));
    return definitions.map(element => ({ ...element, replicas: replicaGroups.find(group => group.id === element.id)?.instances ?? [],
    title: catalog.types.find(type => type.id === element.type)?.title ?? element.type,
    groups: groups.map(group => ({ ...group, metrics: group.metrics.filter(metric => metric.types.includes(element.type)
      && (element.requestType === null ? policyOutputAvailable(metric.id, element.id, policyModels)
        : policyModels.some(effective => Object.entries(effective.blocks).some(([id, block]) => block.type === "client"
          && requestTypes(block.params).includes(element.requestType!) && policyOutputAvailable(metric.id, id, [effective]))))
      && poolOutputAvailable(metric.id, element.id, displayedModels)) }))
      .filter(group => group.metrics.length > 0),
    })).filter(element => element.groups.length > 0);
  }, [model, catalog, groups, replicaGroups, policyModels, displayedModels]);
  const requestTypeOf = (id: string) => elements.find(element => element.id === id)?.requestType ?? null;
  const elementName = (id: string) => requestTypeOf(id) === null ? elementLabel(id, model) : t("results.entries.requestType", { id: requestTypeOf(id)! });
  const canvasKey = JSON.stringify(selectedNodes);
  const availableNodes = elements.flatMap(element => [element.id, ...element.replicas.map(instance => instance.id)]);
  const availableConnections = model.connections.filter(connection => availableNodes.includes(connection.id)).map(connection => connection.id);
  const selectedFromCanvas = [...new Set(selectedNodes.filter(id => availableNodes.includes(id))
    .flatMap(id => originals.has(id) ? [originals.get(id)!, id] : [id]))];
  const initialNodes = selectedNodes.length > 0 ? selectedFromCanvas
    : [availableNodes.find((id) => model.blocks[id]?.type === "service") ?? availableNodes[0]].filter((id) => id !== undefined);
  const [nodeChoice, setNodeChoice] = useState({ canvasKey, ids: initialNodes });
  const nodes = nodeChoice.canvasKey === canvasKey ? nodeChoice.ids
    : selectedNodes.length > 0 ? selectedFromCanvas : nodeChoice.ids;
  if (nodeChoice.canvasKey !== canvasKey) setNodeChoice({ canvasKey, ids: nodes });
  const [metricKeys, setMetricKeys] = useState(() => elements.flatMap(element =>
    element.groups.map(group => metricChoiceKey(element.id, group.metrics[0].key))));
  const context = JSON.stringify([variant?.id, pointId, replication, cursorWindow]);
  const [inspection, setInspection] = useState({ context, window: null as number | null });
  const hover = inspection.context === context ? inspection.window : null;
  if (inspection.context !== context) setInspection({ context, window: null });
  const setHover = (window: number | null) => setInspection({ context, window });
  const metadata = manifest.series;
  const endMs = (metadata?.warmupMs ?? 0) + (metadata?.measurementMs ?? 0);
  const windowMs = metadata?.windowMs ?? 1;
  const count = Math.ceil(endMs / windowMs);
  const nodeIds = nodes.filter((id) => Object.hasOwn(model.blocks, originals.get(id) ?? id));
  const connectionIds = nodes.filter((id) => availableConnections.includes(originals.get(id) ?? id));
  const classIds = nodes.flatMap(id => requestTypeOf(id) === null ? [] : [requestTypeOf(id)!]);
  const targetIds = model.connections.filter(connection => connectionIds.includes(connection.id)
    && outputsUseTarget(outputsOf(catalog, connection.type).filter(output => output.timeline != null))).map(connection => connection.to);
  const targetNodeIds = [...new Set(targetIds)].filter(id => !nodeIds.includes(id));
  const primary = useTimelineSeries(seriesLoader, runId, enabled && metadata ? variant?.id ?? null : null, pointId, replication, nodeIds, count);
  const overlay = useTimelineSeries(seriesLoader, runId, enabled && metadata ? compared?.id ?? null : null, pointId, replication, nodeIds, count);
  const primaryTargets = useTimelineSeries(seriesLoader, runId, enabled && metadata ? variant?.id ?? null : null, pointId, replication, targetNodeIds, count);
  const overlayTargets = useTimelineSeries(seriesLoader, runId, enabled && metadata ? compared?.id ?? null : null, pointId, replication, targetNodeIds, count);
  const primaryClasses = useTimelineSeries(classSeriesLoader, runId,
    enabled && metadata && !primary.loading && !primaryTargets.loading ? variant?.id ?? null : null, pointId, replication, classIds, count);
  const overlayClasses = useTimelineSeries(classSeriesLoader, runId,
    enabled && metadata && !overlay.loading && !overlayTargets.loading ? compared?.id ?? null : null, pointId, replication, classIds, count);
  // Node loads may decode mixed parts that the connection load can then reuse.
  const primaryConnections = useConnectionSeries(seriesLoader, runId,
    enabled && metadata && !primary.loading && !primaryTargets.loading ? variant?.id ?? null : null, pointId, replication, connectionIds, count);
  const overlayConnections = useConnectionSeries(seriesLoader, runId,
    enabled && metadata && !overlay.loading && !overlayTargets.loading ? compared?.id ?? null : null, pointId, replication, connectionIds, count);
  if (!enabled && hover !== null) setHover(null);
  const regions = useMemo(() => timelineRegions(metadata?.warmupMs ?? 0, metadata?.measurementMs ?? 0, experiment.faults, catalog, model),
    [metadata, experiment, catalog, model]);
  const charts = useMemo(() => {
    const lineColor = (element: number, metric: number, comparison: boolean) => {
      // Disjoint palettes distinguish variants while keeping separate element/metric colors.
      const index = compared === undefined ? element * 3 + metric
        : ((element + metric) % (colors.length / 2)) * 2 + Number(comparison);
      return colors[index % colors.length];
    };
    const paramsOf = (type: string, params: Record<string, unknown> = {}) => ({
      ...Object.fromEntries((catalog.types.find(candidate => candidate.id === type)?.params ?? []).map(param => [param.name, param.default])), ...params,
    });
    const [primaryModel = model, comparedModel = model] = displayedModels;
    const requestTypeOf = (id: string) => elements.find(element => element.id === id)?.requestType ?? null;
    const nodeName = (id: string) => requestTypeOf(id) === null ? id : t("results.entries.requestType", { id: requestTypeOf(id)! });
    const nodeType = (id: string) => requestTypeOf(id) === null ? model.blocks[originals.get(id) ?? id]?.type : "client";
    const nodeSeries = (series: readonly NodeSeriesMetrics[], effective: ModelFile) => series.map(node => ({ ...node,
      windows: node.windows.map(window => outputWindow(outputsOf(catalog, nodeType(node.id)), {
        ...window, params: paramsOf(nodeType(node.id), effective.blocks[originals.get(node.id) ?? node.id]?.params),
      })),
    }));
    const classNodes = (series: readonly NodeSeriesMetrics[]) => series.map(node => ({ ...node, id: requestTypeKey(node.id) }));
    const primaryNodes = nodeSeries([...primary.nodes, ...classNodes(primaryClasses.nodes)], primaryModel);
    const overlayNodes = nodeSeries([...overlay.nodes, ...classNodes(overlayClasses.nodes)], comparedModel);
    const connectionType = (id: string) => model.connections.find(connection => connection.id === (originals.get(id) ?? id))?.type ?? "";
    const connectionWindow = (id: string, window: DecodedConnectionWindow, index: number, effective: ModelFile, source: readonly NodeSeriesMetrics[]) => {
      const connection = effective.connections.find(connection => connection.id === (originals.get(id) ?? id));
      const target = source.find(node => node.id === connection?.to)?.windows[index];
      return outputWindow(outputsOf(catalog, connectionType(id)), {
        ...window, params: paramsOf(connectionType(id), connection?.params), target, entries: target?.entries,
      });
    };
    const connectionSeries = primaryConnections.connections.map((connection) => ({
      id: connection.id, windows: connection.windows.map((window, index) => connectionWindow(connection.id, window, index, primaryModel, [...primary.nodes, ...primaryTargets.nodes])),
    }));
    const comparedConnectionSeries = overlayConnections.connections.map((connection) => ({
      id: connection.id, windows: connection.windows.map((window, index) => connectionWindow(connection.id, window, index, comparedModel, [...overlay.nodes, ...overlayTargets.nodes])),
    }));
    const bands: TimelineStateBand[] = [];
    for (const source of [
      { variant, model: primaryModel, rows: [...primary.nodes, ...primaryConnections.connections] },
      { variant: compared, model: comparedModel, rows: [...overlay.nodes, ...overlayConnections.connections] },
    ]) {
      if (source.variant === undefined) continue;
      const membership = source.variant.points.find(point => point.id === pointId)?.aggregate.groups ?? [];
      for (const row of source.rows) {
        if (membership.some(group => group.id === row.id && group.kind === "NODE")) continue;
        const member = replicaMember(membership, row.id);
        const id = member?.group.id ?? row.id;
        const copies = membership.find(group => group.id === row.id)?.instances.length ?? 1;
        const states: PolicyState[] = source.model.connections.some(connection => connection.id === id)
          ? ["circuitOpenShare"] : ["ejectedShare", "notReadyShare"];
        for (const state of states) {
          if (!policyOutputAvailable(state, id, [source.model], member?.instance.replica)) continue;
          bands.push({ id: `${source.variant.id}:${row.id}:${state}`, state, copies,
            label: `${t(`results.timeline.policy.${state}`)} · ${elementLabel(row.id, model)} · ${variantLabel(source.variant, experiment.variants)}`,
            windows: row.windows.map(window => ({ startMs: window.startMs, durationMs: window.durationMs,
              share: policyWindowState(window, copies)[state] })),
          });
        }
      }
    }
    return groups.map((group) => {
      const lines: TimelineLine[] = [];
      for (const metric of group.metrics) {
        const nodeIds = [...new Set([...primaryNodes, ...overlayNodes].map(node => node.id))];
        for (const [nodeIndex, id] of nodeIds.entries()) {
          if (!metric.types.includes(nodeType(id)) || !metricKeys.includes(metricChoiceKey(originals.get(id) ?? id, metric.key))) continue;
          for (const source of [{ variant, data: primaryNodes.find(candidate => candidate.id === id), comparison: false }, {
            variant: compared, data: overlayNodes.find((candidate) => candidate.id === id), comparison: true,
          }]) {
            if (source.variant === undefined || source.data === undefined) continue;
            lines.push({
              id: `${source.variant.id}:${id}:${metric.key}`, label: t("results.timeline.lineLabel", { node: nodeName(id), metric: metric.label, variant: variantLabel(source.variant, experiment.variants), id: source.variant.id }),
              metric: metric.id, scale: group.scale, color: lineColor(nodeIndex, group.metrics.indexOf(metric), source.comparison),
              comparison: source.comparison, windows: source.data.windows,
              range: source.variant.points.find(point => point.id === pointId)?.aggregate.groups.some(group => group.id === id)
                ? replicaRange(outputsOf(catalog, nodeType(id)), metric.id) : undefined,
            });
          }
        }
        for (const [connectionIndex, connection] of connectionSeries.entries()) {
          if (!metric.types.includes(connectionType(connection.id)) || !metricKeys.includes(metricChoiceKey(originals.get(connection.id) ?? connection.id, metric.key))) continue;
          for (const source of [{ variant, data: connection, comparison: false, model: primaryModel }, {
            variant: compared, data: comparedConnectionSeries.find((candidate) => candidate.id === connection.id), comparison: true, model: comparedModel,
          }]) {
            if (source.variant === undefined || source.data === undefined) continue;
            if (!poolOutputAvailable(metric.id, originals.get(connection.id) ?? connection.id, [source.model])) continue;
            const label = t("results.timeline.lineLabel", { node: elementLabel(connection.id, model), metric: metric.label,
              variant: variantLabel(source.variant, experiment.variants) });
            lines.push({ id: `${source.variant.id}:${connection.id}:${metric.key}`, label,
              metric: metric.id, scale: group.scale, color: lineColor(primaryNodes.length + connectionIndex, group.metrics.indexOf(metric), source.comparison),
              comparison: source.comparison,
              range: source.variant.points.find(point => point.id === pointId)?.aggregate.groups.some(group => group.id === connection.id)
                ? replicaRange(outputsOf(catalog, connectionType(connection.id)), metric.id) : undefined,
              windows: source.data.windows });
          }
        }
      }
      return { ...group, lines, bands: group.metrics.some(metric => metric.id === "sentAttemptsPerSecond") ? bands : [] };
    }).filter((group) => group.lines.length > 0 || group.bands.length > 0);
  }, [primary.nodes, overlay.nodes, primaryConnections.connections,
    overlayConnections.connections, primaryClasses.nodes, overlayClasses.nodes, elements, model, metricKeys, variant, compared, groups, catalog, experiment, pointId, primaryTargets.nodes, overlayTargets.nodes, originals, displayedModels]);
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
        label: t("results.timeline.timeout", { connection: elementLabel(connection.id, model), variant: variantLabel(source, experiment.variants), id: source.id }) }];
    });
  });
  if (!enabled) return null;
  if (variant === undefined) return <p>{t("results.timeline.variantUnavailable")}</p>;
  if (metadata == null) return <p>{t("results.timeline.metadataUnavailable")}</p>;
  const activeWindow = hover ?? cursorWindow;
  const onCursor = (window: number | null) => { setHover(null); onCursorChange?.(window); };
  return <div className="timeline">
    <div className="timeline-toolbar">
      <strong>{t("results.timeline.variantLabel", { variant: variantLabel(variant, experiment.variants), id: variant.id })}</strong>
      <label>{t("results.timeline.compare")} <select aria-label={t("results.timeline.compare")} value={compared?.id ?? ""}
        onChange={(event) => setComparison(event.target.value)}>
        <option value="">{t("results.timeline.noComparison")}</option>
        {summary.variants.filter((candidate) => candidate.id !== variant.id).map((candidate) =>
          <option key={candidate.id} value={candidate.id}>{t("results.timeline.variantLabel", { variant: variantLabel(candidate, experiment.variants), id: candidate.id })}</option>)}
      </select></label>
    </div>
    <details className="timeline-choices"><summary>{t("results.timeline.choices")}</summary>
      {elements.map(element => <fieldset key={element.id}>
        <legend><label><input type="checkbox" checked={nodes.includes(element.id)} onChange={event => setNodeChoice({ canvasKey,
          ids: event.target.checked ? [...nodes, element.id] : nodes.filter(id => id !== element.id && !element.replicas.some(instance => instance.id === id)) })} />{elementName(element.id)}</label>{element.requestType === null ? t("results.timeline.elementType", { type: element.title }) : null}</legend>
        {nodes.includes(element.id) ? element.groups.flatMap(group => group.metrics.map(metric => {
          const key = metricChoiceKey(element.id, metric.key);
          return <label key={key}><input type="checkbox" checked={metricKeys.includes(key)} onChange={event =>
            setMetricKeys(event.target.checked ? [...metricKeys, key] : metricKeys.filter(candidate => candidate !== key))} />{metric.label}</label>;
        })) : null}
        {nodes.includes(element.id) ? element.replicas.map(instance => <label key={instance.id}>
          <input type="checkbox" checked={nodes.includes(instance.id)} onChange={event => setNodeChoice({ canvasKey,
            ids: event.target.checked ? [...nodes, instance.id] : nodes.filter(id => id !== instance.id) })} />
          {t("results.timeline.addReplica", { replica: instance.replica })}
        </label>) : null}
      </fieldset>)}
    </details>
    <div className="timeline-regions" aria-label={t("results.timeline.regions")}>
      {regions.map((region, index) => <span key={index} className={`timeline-region--${region.kind}`}>
        {t("results.timeline.region", { label: region.label, from: formatDuration(region.fromMs), to: formatDuration(region.toMs) })}
      </span>)}
      <span>{t("results.timeline.solid", { variant: variantLabel(variant, experiment.variants),
        comparison: compared === undefined ? "" : t("results.timeline.dashed", { variant: variantLabel(compared, experiment.variants) }) })}</span>
    </div>
    <p className="timeline-cursor" role="status" data-testid="timeline-cursor">
      {activeWindow === null ? t("results.timeline.inspect")
        : t("results.timeline.window", {
          window: formatNumber(activeWindow), from: formatDuration(activeWindow * windowMs),
          to: formatDuration(Math.min(endMs, (activeWindow + 1) * windowMs)), replication: formatNumber(replication),
          pinned: hover === null && cursorWindow !== null ? t("results.timeline.pinned") : "",
        })}
    </p>
    {primary.loading || overlay.loading || primaryTargets.loading || overlayTargets.loading || primaryClasses.loading || overlayClasses.loading || primaryConnections.loading || overlayConnections.loading ? <p role="status">{t("results.timeline.loadingSeries")}</p> : null}
    {primary.problem === null ? null : <p role="status">{primary.problem}</p>}
    {primaryTargets.problem === null ? null : <p role="status">{primaryTargets.problem}</p>}
    {overlayTargets.problem === null ? null : <p role="status">{t("results.timeline.comparisonProblem", { problem: overlayTargets.problem })}</p>}
    {overlay.problem === null ? null : <p role="status">{t("results.timeline.comparisonProblem", { problem: overlay.problem })}</p>}
    {primaryConnections.problem === null ? null : <p role="status">{primaryConnections.problem}</p>}
    {overlayConnections.problem === null ? null : <p role="status">{t("results.timeline.comparisonProblem", { problem: overlayConnections.problem })}</p>}
    {primaryClasses.problem === null ? null : <p role="status">{primaryClasses.problem}</p>}
    {overlayClasses.problem === null ? null : <p role="status">{t("results.timeline.comparisonProblem", { problem: overlayClasses.problem })}</p>}
    {connectionIds.length > 0 ? <p className="timeline-latency-note">{t("results.timeline.connectionLegend")}</p> : null}
    {nodes.length === 0 ? <p>{t("results.timeline.selectNodes")}</p> : null}
    {!primary.loading && !primaryConnections.loading && primary.problem === null && primaryConnections.problem === null && nodes.length > 0 && charts.length === 0 ? <p>{t("results.timeline.selectMetrics")}</p> : null}
    <TimelineGrid>{charts.map((group) => <TimelineChart key={group.id} title={group.title} unit={group.unit}
      lines={group.lines} bands={group.bands} regions={regions} thresholds={group.unit === "ms" ? thresholds : undefined} endMs={endMs} windowMs={windowMs} hoverWindow={hover} cursorWindow={cursorWindow}
      onHover={setHover} onCursor={onCursor} />)}</TimelineGrid>
  </div>;
}
