import { t } from "../i18n";
import { formatDuration, formatInterval, formatMultiplier, formatNumber, formatPercent } from "../i18n/format";
import type { ReactNode } from "react";
import type { MetricSummary, RunSummary } from "../api/apiTypes";
import { SaturationInsight } from "../results/SaturationInsight";
import { formatHeadroom } from "../results/saturation";
import { confidenceInterval, type ConfidenceLevel } from "../results/confidence";
import { useConfidenceLevel } from "./confidenceLevel";

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
}

/** Answer for the active page and a baseline comparison at the selected grid point (stage 1 §6.3). */
export function SummaryTable({ summary, activeVariantId = null, selectedPointId = "p0", onElement }: SummaryTableProps) {
  const level = useConfidenceLevel();
  const baseline = summary.variants.find(variant => variant.id === "baseline") ?? summary.variants[0];
  const ordered = baseline === undefined ? [] : [baseline, ...summary.variants.filter(variant => variant !== baseline)];
  const columns = ordered.flatMap(variant => {
    const point = variant.points.find(point => point.id === selectedPointId);
    return point === undefined ? [] : [{ variant, point }];
  });
  const reference = baseline?.points.find(point => point.id === selectedPointId);
  const activeVariant = activeVariantId === null ? summary.variants[0] : summary.variants.find(variant => variant.id === activeVariantId);
  const activePoint = activeVariant?.points.find(point => point.id === selectedPointId);
  const coordinates = summary.grid.length === 0 ? "" : Object.entries(activePoint?.coordinates ?? {}).map(([path, value]) => t("results.coordinate", {
    path, value: typeof value === "number" ? formatNumber(value) : typeof value === "string" ? value : JSON.stringify(value),
  })).join(t("results.coordinateSeparator"));
  const variantLabel = activeVariant?.label ?? activeVariantId ?? t("results.variant");
  const headroom = activePoint !== undefined && activeVariant !== undefined && activeVariant.replications > 0
    && activePoint.saturation.withoutSaturation === activeVariant.replications ? formatHeadroom(activePoint.aggregate) : null;
  const services = [...new Set(columns.flatMap(({ point }) => Object.keys(point.aggregate.services)))].sort();
  const columnClass = (id: string) => id === activeVariantId ? "summary-column--active-variant" : undefined;
  const row = (label: string, value: (point: Point) => Metric | null | undefined, format: Format, difference: Format = format) => (
    <tr>
      <th scope="row">{label}</th>
      {columns.map(({ variant, point }) => <td key={variant.id} className={columnClass(variant.id)}>
        {metric(value(point), variant.id === baseline?.id || reference === undefined ? undefined : value(reference),
          level, format, difference)}
      </td>)}
    </tr>
  );
  return <div className="answer">
    <section className="answer-insight" aria-label={t("results.saturation.title")}>
      <h3>{coordinates === "" ? variantLabel : t("results.answer.forVariant", { variant: variantLabel, point: coordinates })}</h3>
      {activePoint === undefined || activeVariant === undefined ?
        <p>{t("results.answer.noPoint", { variant: activeVariant?.label ?? activeVariantId ?? t("results.variant"), point: selectedPointId })}</p> :
        <SaturationInsight saturation={activePoint.saturation} replications={activeVariant.replications} headroom={headroom} />}
    </section>
    {baseline !== undefined && reference === undefined ? <p>{t("results.answer.baselineMissing", { variant: baseline.label, point: selectedPointId })}</p> : null}
    <table className="summary-table" aria-label={t("results.answer.title")}>
      <caption>{t("results.answer.comparison", { variant: baseline?.label ?? t("results.variant") })}</caption>
      <thead><tr>
        <th scope="col">{t("results.answer.metric")}</th>
        {columns.map(({ variant, point }) => <th key={variant.id} scope="col" className={columnClass(variant.id)}>
          {variant.label}
          <span className="summary-replications">{t("results.answer.replications", { count: formatNumber(variant.replications) })}</span>
          {[point.aggregate.successRate, point.aggregate.p95LatencyMs, point.aggregate.p99LatencyMs,
            ...Object.values(point.aggregate.services).map(service => service.admittedAmplification)]
            .some(value => value != null && value.count < MIN_RELIABLE_REPLICATIONS) ? <span className="summary-reliability-warning">{t("results.answer.lowReplications")}</span> : null}
        </th>)}
      </tr></thead>
      <tbody>
        {row(t("results.metrics.successRate"), point => point.aggregate.successRate, formatPercent, percentagePoints)}
        {row(t("results.metrics.p95LatencyMs"), point => point.aggregate.p95LatencyMs, formatDuration)}
        {row(t("results.metrics.p99LatencyMs"), point => point.aggregate.p99LatencyMs, formatDuration)}
      </tbody>
    </table>
    {services.map(service => <details key={service} className="summary-services">
      <summary onClick={() => onElement?.(service)}>{t("results.answer.serviceMetrics", { service })}</summary>
      <table className="summary-table" aria-label={t("results.answer.servicesFor", { service })}>
        <thead><tr>
          <th scope="col">{t("results.answer.metric")}</th>
          {columns.map(({ variant }) => <th key={variant.id} scope="col" className={columnClass(variant.id)}>{variant.label}</th>)}
        </tr></thead>
        <tbody>
          {row(t("results.metrics.admittedAmplification"), point => point.aggregate.services[service]?.admittedAmplification, formatMultiplier)}
          {row(t("results.metrics.pooledUtilization"), point => {
            const totals = point.aggregate.services[service]?.totals;
            return totals == null || totals.handlerCapacityTimeMs === 0 ? undefined : { mean: totals.busyHandlerTimeMs / totals.handlerCapacityTimeMs };
          }, formatPercent, percentagePoints)}
        </tbody>
      </table>
    </details>)}
  </div>;
}
