import { FailureReasons } from "../results/EntryResults";
import { entryPopulations, failureMetric, hasEntryDetails, hasFallback, hasUnreliableEntryInterval, type EntryMetrics } from "../results/entries";
import { instanceServiceEntries } from "../results/instances";
import { serviceResultRows } from "../results/groups";
import { t } from "../i18n";
import { formatDuration, formatInterval, formatMultiplier, formatNumber, formatPercent } from "../i18n/format";
import { useId, type ReactNode } from "react";
import { HelpHint } from "../help/HelpHint";
import type { Catalog, MetricSummary, ModelFile, RunSummary } from "../api/apiTypes";
import type { CourseFault } from "../experiment/course";
import { applyOverrides, ownEntry, type Params } from "../workspace/params";
import { comparisonConclusion, latencyLimitMatch, latencyLimits, saturationConclusions } from "../results/findings";
import { SaturationInsight } from "../results/SaturationInsight";
import { formatHeadroom } from "../results/saturation";
import { CONFIDENCE_LEVELS, confidenceInterval, type ConfidenceLevel } from "../results/confidence";
import { setConfidenceLevel, useConfidenceLevel } from "./confidenceLevel";
import { pointLabel, variantLabel, type NamedVariant } from "../presentation/labels";
import { outputNote } from "../results/outputs";

const MIN_RELIABLE_REPLICATIONS = 5;
type Metric = Pick<MetricSummary, "mean" | "stdDev"> & Partial<Pick<MetricSummary, "count">>;
type Point = RunSummary["variants"][number]["points"][number];
type Format = (value: number) => string;

const percentagePoints: Format = value => t("results.answer.percentagePoints", { value: formatNumber(value * 100, 1) });

/** Mean and unmodified Student bounds; interval overlap is descriptive, not a significance test. */
function metric(value: Metric | null | undefined, baseline: Metric | null | undefined,
  level: ConfidenceLevel, format: Format, formatDifference: Format): ReactNode {
  if (value == null) return formatNumber(null);
  const interval = confidenceInterval(value, level);
  const reference = confidenceInterval(baseline, level);
  const separate = interval !== null && reference !== null && (interval[1] < reference[0] || reference[1] < interval[0]);
  const difference = baseline == null ? null : value.mean - baseline.mean;
  const formattedDifference = difference === null ? null : formatDifference(difference);
  return <>
    {format(value.mean)}
    {difference === null ? null : <span className="summary-difference">
      {difference > 0 && formattedDifference !== formatDifference(0)
        ? t("results.answer.positiveDifference", { value: formattedDifference! }) : formattedDifference}
    </span>}
    {interval === null ? null :
      <span className={`summary-interval${(value.count ?? 0) < MIN_RELIABLE_REPLICATIONS ? " summary-interval--unreliable" : ""}`}>
        {t("results.intervalInParens", { interval: formatInterval(interval[0], interval[1], format, level) })}
      </span>}
    {separate ? <span className="summary-intervals-separate">{t("results.answer.intervalsSeparate")}</span> : null}
  </>;
}

interface SummaryTableProps {
  summary: RunSummary;
  activeVariantId?: string | null;
  selectedPointId?: string;
  onElement?: (id: string) => void;
  faults?: readonly CourseFault[];
  windowMs?: number;
  catalog?: Catalog | null;
  model?: ModelFile | null;
  variants?: readonly (NamedVariant & { overrides?: Params })[];
}

/** Findings for the active page and a baseline comparison at the selected grid point (stage 1 §6.3). */
export function SummaryTable({ summary, activeVariantId = null, selectedPointId = "p0", onElement, faults = [], windowMs = 0, catalog, model, variants = summary.variants }: SummaryTableProps) {
  const level = useConfidenceLevel();
  const confidenceHelpId = useId();
  const baseline = summary.variants.find(variant => variant.id === "baseline") ?? summary.variants[0];
  const ordered = baseline === undefined ? [] : [baseline, ...summary.variants.filter(variant => variant !== baseline)];
  const columns = ordered.flatMap(variant => {
    const point = variant.points.find(point => point.id === selectedPointId);
    if (point === undefined) return [];
    const effective = model == null || catalog == null ? null : applyOverrides(applyOverrides(model,
      variants.find(source => source.id === variant.id)?.overrides ?? {}, catalog), point.coordinates, catalog);
    return [{ variant, point, effective, limits: effective === null || catalog == null ? [] : latencyLimits(effective, catalog) }];
  });
  const reference = baseline?.points.find(point => point.id === selectedPointId);
  const activeVariant = activeVariantId === null ? summary.variants[0] : summary.variants.find(variant => variant.id === activeVariantId);
  const activePoint = activeVariant?.points.find(point => point.id === selectedPointId);
  const coordinates = summary.grid.length === 0 ? "" : pointLabel(selectedPointId, summary.grid, (activePoint ?? columns[0]?.point)?.coordinates, catalog, model);
  const activeLabel = variantLabel(activeVariant, variants);
  const selectedPointLabel = pointLabel(selectedPointId, summary.grid, (activePoint ?? columns[0]?.point)?.coordinates, catalog, model);
  const headroom = activePoint !== undefined && activeVariant !== undefined && activeVariant.replications > 0
    && activePoint.saturation.withoutSaturation === activeVariant.replications ? formatHeadroom(activePoint.aggregate, activePoint.headroom) : null;
  const aggregates = columns.map(({ point }) => point.aggregate);
  const models = columns.map(column => column.effective ?? model);
  const populations = entryPopulations(aggregates, models);
  const showFailures = hasEntryDetails(aggregates, models);
  const showDegraded = hasFallback(aggregates, models);
  const services = serviceResultRows(columns.map(({ point }) => point.aggregate));
  const columnClass = (id: string) => id === activeVariantId ? "summary-column--active-variant" : undefined;
  const row = (label: string, value: (point: Point) => Metric | null | undefined, format: Format, difference: Format = format,
    quantile?: "p95LatencyMs" | "p99LatencyMs") => (
    <tr>
      <th scope="row">{label}</th>
      {columns.map(({ variant, point, limits }, index) => {
        const limit = quantile === undefined ? null : latencyLimitMatch(point.aggregate.entries.total[quantile], limits);
        const current = value(point);
        const note = format === formatMultiplier ? outputNote({ id: "amplification" }, current?.mean, current === null ? "noArrivals" : "missingData") : null;
        return <td key={variant.id} className={columnClass(variant.id)}>
          {metric(current, variant.id === baseline?.id || reference === undefined ? undefined : value(reference),
            level, format, difference)}
          {index === 0 && format === formatMultiplier ? <HelpHint label={label}>{t("catalog.types.call.outputs.amplification.description")}</HelpHint> : null}
          {note === null ? null : <small className="output-note">{note}</small>}
          {limit === null ? null : <span className="summary-limit" title={t("results.answer.ceilingHelp")}>{limit}</span>}
        </td>;
      })}
    </tr>
  );
  const failureRow = (entry: (point: Point) => EntryMetrics | undefined) => {
    const reasons = [...new Set(columns.flatMap(({ point }) => Object.keys(entry(point)?.failuresByReason ?? {})))].sort();
    return <tr><th scope="row">{t("results.entries.failureReasons")}</th>{columns.map(({ variant, point }) =>
      <td key={variant.id} className={columnClass(variant.id)}><FailureReasons entry={entry(point)} reasons={reasons}
        renderValue={(code, value) => metric(value, variant.id === baseline?.id || reference === undefined
          ? undefined : failureMetric(entry(reference), code), level, formatPercent, percentagePoints)} /></td>)}</tr>;
  };
  const entryRows = (entry: (point: Point) => EntryMetrics | undefined) => <>
    {row(t("results.metrics.successRate"), point => entry(point)?.successRate, formatPercent, percentagePoints)}
    {row(t("results.metrics.p95LatencyMs"), point => entry(point)?.p95LatencyMs, formatDuration)}
    {row(t("results.metrics.p99LatencyMs"), point => entry(point)?.p99LatencyMs, formatDuration)}
    {showFailures ? failureRow(entry) : null}
    {showDegraded ? row(t("results.entries.degraded"), point => entry(point)?.degradedRate, formatPercent, percentagePoints) : null}
  </>;
  const populationGroup = (kind: "clients" | "classes", ids: string[]) => ids.length < 2 ? null : <details className="summary-services">
    <summary>{t(kind === "clients" ? "results.entries.byClients" : "results.entries.byRequestTypes")}</summary>
    {ids.map(id => <table key={id} className="summary-table" aria-label={t(kind === "clients" ? "results.entries.client" : "results.entries.requestType", { id })}>
      <caption>{id}</caption><thead><tr><th scope="col">{t("results.answer.metric")}</th>
        {columns.map(({ variant, point }) => <th key={variant.id} scope="col" className={columnClass(variant.id)}>{variantLabel(variant, variants)}
          {hasUnreliableEntryInterval(ownEntry(point.aggregate.entries[kind], id))
            ? <span className="summary-reliability-warning">{t("results.answer.lowReplications")}</span> : null}
        </th>)}
      </tr></thead><tbody>{entryRows(point => ownEntry(point.aggregate.entries[kind], id))}</tbody>
    </table>)}
  </details>;
  const serviceDetails = (service: string, instances: { id: string; replica: number }[] = [], replica = false): ReactNode => <details key={service} className="summary-services">
      <summary onClick={event => { event.stopPropagation(); onElement?.(service); }}>{t(instances.length === 0 ? "results.answer.serviceMetrics" : "results.groups.metrics", { service, group: service })}</summary>
      <table className="summary-table" aria-label={t("results.answer.servicesFor", { service })}>
        <thead><tr>
          <th scope="col">{t("results.answer.metric")}</th>
          {columns.map(({ variant }) => <th key={variant.id} scope="col" className={columnClass(variant.id)}>{variantLabel(variant, variants)}</th>)}
        </tr></thead>
        <tbody>
          {row(t("results.metrics.admittedAmplification"), point => point.aggregate.services[service]?.admittedAmplification, formatMultiplier)}
          {row(t("results.metrics.pooledUtilization"), point => {
            const totals = point.aggregate.services[service]?.totals;
            return totals == null || totals.slotPools.handlers.capacityIntegralMs === 0 ? undefined : { mean: totals.slotPools.handlers.busyIntegralMs / totals.slotPools.handlers.capacityIntegralMs };
          }, formatPercent, percentagePoints)}
          {instances.length === 0 && !replica ? null : row(t("results.metrics.p99LatencyMs"), point => {
            const value = point.aggregate.services[service]?.pooledLatency?.p99Ms;
            return value == null ? undefined : { mean: value };
          }, formatDuration)}
        </tbody>
      </table>
      {instances.map(instance => serviceDetails(instance.id, [], true))}
    </details>;
  return <div className="answer">
    <section className="answer-variants" aria-label={t("results.answer.variants")}>
      <h3>{coordinates === "" ? t("results.answer.variants") : t("results.answer.forPoint", { point: coordinates })}</h3>
      <p data-testid="comparison-conclusion">{(["successRate", "p99LatencyMs"] as const).map(criterion => comparisonConclusion(
        columns.map(({ variant, point }) => ({ label: variantLabel(variant, variants), metric: point.aggregate.entries.total[criterion] })), criterion, level,
      )).join(" ")}</p>
      {saturationConclusions(columns.map(({ variant, point }) => ({ label: variantLabel(variant, variants), saturation: point.saturation })),
        columns.length === summary.variants.length).map((conclusion, index) => <p key={index}>{conclusion}</p>)}
    </section>
    <section className="answer-insight" aria-label={t("results.saturation.title")}>
      <header className="answer-heading">
        <h3>{coordinates === "" ? activeLabel : t("results.answer.forVariant", { variant: activeLabel, point: coordinates })}</h3>
        <div className="answer-controls">
          <label>{t("results.answer.intervalsLabel")} <select aria-label={t("results.answer.intervals")}
            aria-describedby={confidenceHelpId} value={level}
            onChange={event => setConfidenceLevel(Number(event.target.value) as ConfidenceLevel)}>
            {CONFIDENCE_LEVELS.map(option => <option key={option} value={option}>{formatPercent(option / 100)}</option>)}
          </select></label>
          <HelpHint label={t("results.answer.intervals")} id={confidenceHelpId}>{t("results.answer.intervalsHelp")}</HelpHint>
        </div>
      </header>
      {activePoint === undefined || activeVariant === undefined ?
        <p>{t("results.answer.noPoint", { variant: activeLabel, point: selectedPointLabel })}</p> :
        <SaturationInsight saturation={activePoint.saturation} replications={activeVariant.replications} headroom={headroom}
          faults={faults} windowMs={windowMs} onElement={onElement} />}
    </section>
    {baseline !== undefined && reference === undefined ? <p>{t("results.answer.baselineMissing", { variant: variantLabel(baseline, variants), point: selectedPointLabel })}</p> : null}
    <table className="summary-table" aria-label={t("results.answer.title")}>
      <caption>{t("results.answer.comparison", { variant: variantLabel(baseline, variants) })}</caption>
      <thead><tr>
        <th scope="col">{t("results.answer.metric")}</th>
        {columns.map(({ variant, point }) => <th key={variant.id} scope="col" className={columnClass(variant.id)}>
          {variantLabel(variant, variants)}
          <span className="summary-replications">{t("results.answer.replications", { count: formatNumber(variant.replications) })}</span>
          {[point.aggregate.entries.total.successRate, point.aggregate.entries.total.p95LatencyMs, point.aggregate.entries.total.p99LatencyMs,
            ...instanceServiceEntries(point.aggregate).map(([, service]) => service.admittedAmplification)]
            .some(value => value != null && value.count < MIN_RELIABLE_REPLICATIONS) ? <span className="summary-reliability-warning">{t("results.answer.lowReplications")}</span> : null}
        </th>)}
      </tr></thead>
      <tbody>
        {row(t("results.metrics.successRate"), point => point.aggregate.entries.total.successRate, formatPercent, percentagePoints)}
        {row(t("results.metrics.p95LatencyMs"), point => point.aggregate.entries.total.p95LatencyMs, formatDuration, formatDuration, "p95LatencyMs")}
        {row(t("results.metrics.p99LatencyMs"), point => point.aggregate.entries.total.p99LatencyMs, formatDuration, formatDuration, "p99LatencyMs")}
        {showFailures ? failureRow(point => point.aggregate.entries.total) : null}
        {showDegraded ? row(t("results.entries.degraded"), point => point.aggregate.entries.total.degradedRate, formatPercent, percentagePoints) : null}
      </tbody>
    </table>
    {populationGroup("clients", populations.clients)}
    {populationGroup("classes", populations.classes)}
    {services.map(service => serviceDetails(service.id, service.instances))}
  </div>;
}
