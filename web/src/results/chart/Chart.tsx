import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n";
import { formatDuration, formatMultiplier, formatNumber, formatPercent, formatRate } from "../../i18n/format";
import { observeResize } from "../../layout/observeResize";
import { axisTicks, bandPath, linearScale, sampleBand, samplePoints, stepPath, windowAt, yDomain } from "./data";
import { chartColors, chartSeriesColors } from "./palette";
import { useChartCursor } from "./useChartCursor";
import type { ChartDash, ChartDescription, ChartOverlay } from "./types";

const dashArray = (dash?: ChartDash) => dash === "dashed" ? "6 4" : dash === "dotted" ? "2 3" : undefined;
const formatValue = (value: number | null, unit: string): string => value === null ? t("results.timeline.noValue")
  : unit === "ms" ? formatDuration(value) : unit === "RPS" ? formatRate(value)
    : unit === "%" ? formatPercent(value / 100) : unit === "×" ? formatMultiplier(value)
      : t("results.timeline.valueWithUnit", { value: formatNumber(value), unit: t(`results.units.${unit}`) });

/** One SVG plot geometry drives axes, sampled paths and pointer coordinates in both presets. */
export function Chart({ description, className = "" }: { description: ChartDescription; className?: string }) {
  const { title, unit, x: axis, series, overlays = [], preset = "full" } = description;
  const colors = useMemo(() => chartSeriesColors(series, description.colorBy ?? "element"), [series, description.colorBy]);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const clipId = useId();
  const cursor = useChartCursor(axis.id);
  const compact = preset === "compact";
  const height = compact ? 80 : 176;
  const plot = compact ? { left: 32, right: 8, top: 8, bottom: 18 } : { left: 56, right: 12, top: 12, bottom: 32 };
  const plotWidth = Math.max(1, width - plot.left - plot.right), plotBottom = height - plot.bottom;
  useLayoutEffect(() => {
    const element = container.current;
    if (element === null) return;
    const measure = (next: number) => { if (next > 0) setWidth(next); };
    measure(element.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "undefined") return observeResize([element], entries => measure(entries[0].contentRect.width));
  }, []);
  const sampled = useMemo(() => series.map(line => ({ ...line,
    points: samplePoints(line.points, plotWidth, point => point.x),
    range: line.range === undefined ? [] : sampleBand(line.range, plotWidth, point => point.x),
  })), [series, plotWidth]);
  function* values() {
    for (const line of series) {
      for (const point of line.points) yield point.value;
      for (const point of line.range ?? []) if (point.range !== null) yield* point.range;
    }
    for (const overlay of overlays) if (overlay.kind === "threshold" || overlay.kind === "marker") yield overlay.value;
  }
  const domain = yDomain(values(), description.y);
  const x = linearScale(axis.domain, [plot.left, width - plot.right]);
  const y = linearScale(domain, [plotBottom, plot.top]);
  const durationSeconds = unit === "ms" && (series.some(line => line.points.some(point => point.value !== null && Math.abs(point.value) >= 1000))
    || overlays.some(overlay => overlay.kind === "threshold" && Math.abs(overlay.value) >= 1000));
  const timeSeconds = axis.kind === "time" && axis.domain[1] >= 1000;
  const ticksX = compact ? [...axis.domain] : axisTicks(axis.domain);
  const ticksY = compact ? domain : axisTicks(domain, 5);
  const active = cursor?.hoverWindow ?? cursor?.cursorWindow ?? null;
  const lastWindow = axis.kind === "time" ? Math.max(0, Math.ceil(axis.domain[1] / axis.windowMs) - 1)
    : series.reduce((last, line) => line.points.reduce((last, point) => Math.max(last, point.window), last), 0);
  const xForWindow = (window: number) => axis.kind === "time" ? window * axis.windowMs
    : series[0]?.points.find(point => point.window === window)?.x ?? axis.domain[0];
  const pointerWindow = (event: { currentTarget: SVGGElement; clientX: number }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const value = axis.domain[0] + (event.clientX - bounds.left) / bounds.width * (axis.domain[1] - axis.domain[0]);
    if (axis.kind === "time") return windowAt(value, axis.windowMs, axis.domain[1]);
    return null;
  };
  const seekByKey = (event: KeyboardEvent<SVGGElement>) => {
    const current = cursor?.cursorWindow ?? 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? lastWindow
      : event.key === "ArrowRight" ? Math.min(lastWindow, current + 1)
        : event.key === "ArrowLeft" ? Math.max(0, current - 1) : null;
    if (next !== null && cursor !== null) { event.preventDefault(); cursor.onCursor(next); }
  };
  const interaction = (label: string, valueText?: string) => ({
    role: "slider", tabIndex: cursor === null ? -1 : 0, "aria-label": label,
    "aria-disabled": cursor === null, "aria-valuemin": 0, "aria-valuemax": lastWindow, "aria-valuenow": cursor?.cursorWindow ?? 0,
    "aria-valuetext": valueText ?? (cursor?.cursorWindow == null ? t("results.timeline.noPinnedWindow")
      : t("results.timeline.pinnedWindow", { window: formatNumber(cursor.cursorWindow), time: formatDuration(xForWindow(cursor.cursorWindow)) })),
    onPointerMove: (event: { currentTarget: SVGGElement; clientX: number }) => cursor?.onHover(pointerWindow(event)),
    onPointerLeave: () => cursor?.onHover(null),
    onClick: (event: { currentTarget: SVGGElement; clientX: number }) => cursor?.onCursor(pointerWindow(event)), onKeyDown: seekByKey,
  });
  const cursorLines = (top: number, bottom: number) => <>
    {cursor?.cursorWindow == null ? null : <line className="chart-cursor" data-cursor-window={cursor.cursorWindow}
      x1={x(xForWindow(cursor.cursorWindow))} x2={x(xForWindow(cursor.cursorWindow))} y1={top} y2={bottom}
      stroke={chartColors.cursor} strokeWidth={2} />}
    {cursor?.hoverWindow == null ? null : <line className="chart-hover" data-hover-window={cursor.hoverWindow}
      x1={x(xForWindow(cursor.hoverWindow))} x2={x(xForWindow(cursor.hoverWindow))} y1={top} y2={bottom}
      stroke={chartColors.hover} strokeDasharray="3 3" />}
  </>;
  const thresholds = overlays.filter(overlay => overlay.kind === "threshold");
  const states = overlays.filter(overlay => overlay.kind === "state");
  const stateDescription = (state: Extract<ChartOverlay, { kind: "state" }>) =>
    state.points.find(point => point.window === active)?.description ?? t("results.timeline.noValue");
  return <section className={`chart chart--${preset} ${className}`} aria-label={title}>
    <h3>{title} <span>{t("results.unitInParens", { unit: t(durationSeconds ? "results.units.s" : `results.units.${unit}`) })}</span></h3>
    <div className="chart-plot" ref={container}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
        <defs><clipPath id={clipId}><rect x={plot.left} y={plot.top} width={plotWidth} height={plotBottom - plot.top} /></clipPath></defs>
        {ticksY.map(value => <g key={value}>
          <line x1={plot.left} x2={width - plot.right} y1={y(value)} y2={y(value)} stroke={chartColors.grid} strokeDasharray="3 3" />
          <text className="chart-y-tick" x={plot.left - 4} y={y(value)} dy="0.35em" textAnchor="end">{formatNumber(durationSeconds ? value / 1000 : value)}</text>
        </g>)}
        {ticksX.map(value => <g key={value}>
          <line x1={x(value)} x2={x(value)} y1={plot.top} y2={plotBottom} stroke={chartColors.grid} strokeDasharray="3 3" />
          <text className="chart-x-tick" x={x(value)} y={height - 8} textAnchor={value === axis.domain[0] ? "start" : value === axis.domain[1] ? "end" : "middle"}>
            {formatNumber(timeSeconds ? value / 1000 : value)}</text>
        </g>)}
        <g clipPath={`url(#${clipId})`}>
          {overlays.filter(overlay => overlay.kind === "region").map(region => <rect className="chart-region" key={region.id}
            x={x(region.from)} width={x(region.to) - x(region.from)} y={plot.top} height={plotBottom - plot.top}
            fill={chartColors[region.role]} opacity={0.14}><title>{region.label}</title></rect>)}
          {sampled.map(line => {
            const color = colors.get(line.id)!;
            return <g key={line.id} data-series={line.id}>
              {line.range.length === 0 ? null : <path className="chart-range" d={bandPath(line.range, x, y)} fill={color} fillOpacity={0.14}
                stroke={color} strokeOpacity={0.35} strokeDasharray={dashArray(line.dash)} />}
              <path className="chart-line" d={stepPath(line.points, x, y)} fill="none" stroke={color}
                strokeWidth={line.width ?? 1.6} strokeDasharray={dashArray(line.dash)} />
              {line.marker === undefined ? null : <g className="chart-markers">{line.points.filter(point => point.value !== null).map(point =>
                line.marker === "square" ? <rect key={`${point.window}:${point.x}`} className="chart-marker chart-marker--square"
                  x={x(point.x) - 2.5} y={y(point.value!) - 2.5} width={5} height={5} fill="#fff" stroke={color} />
                  : <circle key={`${point.window}:${point.x}`} className="chart-marker" cx={x(point.x)} cy={y(point.value!)} r={2} fill="#fff" stroke={color} />)}</g>}
            </g>;
          })}
          {thresholds.map(threshold => <line className="chart-threshold" key={threshold.id} x1={plot.left} x2={width - plot.right}
            y1={y(threshold.value)} y2={y(threshold.value)} stroke={chartColors.threshold} strokeDasharray={dashArray(threshold.dash) ?? "3 3"} />)}
          {overlays.filter(overlay => overlay.kind === "marker").map(marker => <circle className="chart-marker" key={marker.id}
            cx={x(marker.x)} cy={y(marker.value)} r={2} fill={marker.color ?? chartColors.threshold}><title>{marker.label}</title></circle>)}
          {cursorLines(plot.top, plotBottom)}
        </g>
        <g className="chart-interaction" {...interaction(t("results.timeline.timeCursor", { title }))}>
          <rect x={plot.left} y={plot.top} width={plotWidth} height={plotBottom - plot.top} fill="transparent" />
        </g>
      </svg>
    </div>
    <p className="chart-axis" style={{ paddingLeft: plot.left, paddingRight: plot.right }}>{axis.label}</p>
    {states.length === 0 ? null : <div className="chart-policy-states">{states.map(state => <div key={state.id} className="chart-policy-state">
      <div>{state.label}</div>
      <svg className="chart-state-band" viewBox={`0 0 ${width} 12`} width="100%" height={12}>
        <g className="chart-interaction" {...interaction(state.label, stateDescription(state))}>
          <rect x={plot.left} width={plotWidth} y={0} height={12} fill="#f1f5f9" />
          {state.points.map(point => <rect key={point.window} data-window={point.window} data-share={point.value ?? undefined}
            x={x(point.x)} width={x(point.endX) - x(point.x)} y={0} height={12} fill={state.color}
            opacity={point.value === null ? 0.03 : 0.06 + 0.84 * Math.min(1, Math.max(0, point.value))}><title>{point.description}</title></rect>)}
          {cursorLines(0, 12)}
        </g>
      </svg>
      <small>{stateDescription(state)}</small>
    </div>)}</div>}
    {description.note === undefined ? null : <p className="chart-note">{description.note}</p>}
    {compact ? null : <dl className="chart-readout">
      {thresholds.map(threshold => <div key={threshold.id}>
        <dt><span className="chart-line-key" style={{ borderColor: chartColors.threshold, borderTopStyle: "dashed" }} />{threshold.label}</dt>
        <dd>{formatValue(threshold.value, unit)}</dd>
      </div>)}
      {series.map(line => {
        const point = line.points.find(point => point.window === active);
        const range = line.range?.find(point => point.window === active)?.range;
        return <div key={line.id}>
          <dt><span className={`chart-line-key${line.dash === "dashed" ? " chart-line-key--dashed" : ""}${line.marker === undefined ? "" : ` chart-line-key--${line.marker}`}`}
            style={{ borderColor: colors.get(line.id), borderTopStyle: line.dash === "dashed" ? "dashed" : line.dash === "dotted" ? "dotted" : "solid" }} />{line.label}</dt>
          <dd>{formatValue(point?.value ?? null, unit)}{line.range === undefined ? null : <span className="chart-range-readout">{t("results.timeline.replicaRange", {
            min: formatValue(range?.[0] ?? null, unit), max: formatValue(range?.[1] ?? null, unit),
          })}</span>}</dd>
        </div>;
      })}
    </dl>}
  </section>;
}
