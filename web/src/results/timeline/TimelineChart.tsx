import { t } from "../../i18n";
import { formatDuration, formatMultiplier, formatNumber, formatPercent, formatRate } from "../../i18n/format";
import { useMemo, useState, type KeyboardEvent } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { downsample, replicaBand, windowAt, type TimelinePoint, type TimelineRegion, type TimelineMetricValues } from "./data";
import type { PolicyState } from "../policyState";

export interface TimelineLine {
  id: string;
  label: string;
  metric: keyof TimelineMetricValues;
  scale: number;
  color: string;
  comparison: boolean;
  windows: readonly TimelineMetricValues[];
  range?: readonly [string, string];
}

export interface TimelineThreshold {
  id: string;
  label: string;
  value: number;
  comparison: boolean;
}

export interface TimelineStateBand {
  id: string;
  label: string;
  state: PolicyState;
  copies: number;
  windows: readonly { startMs: number; durationMs: number; share: number | null }[];
}

interface TimelineChartProps {
  title: string;
  unit: string;
  lines: TimelineLine[];
  bands?: TimelineStateBand[];
  regions: TimelineRegion[];
  thresholds?: TimelineThreshold[];
  endMs: number;
  windowMs: number;
  hoverWindow: number | null;
  cursorWindow: number | null;
  onHover: (window: number | null) => void;
  onCursor: (window: number | null) => void;
}

/** Numeric time axes stay aligned across independently sampled lines; readouts always use original windows. */
export function TimelineChart({ title, unit, lines, bands = [], regions, thresholds = [], endMs, windowMs, hoverWindow, cursorWindow, onHover, onCursor }: TimelineChartProps) {
  const [width, setWidth] = useState(640);
  const seconds = endMs >= 1000;
  const durationSeconds = unit === "ms" && (thresholds.some(threshold => Math.abs(threshold.value) >= 1000)
    || lines.some(line => line.windows.some(window => Math.abs((window[line.metric] ?? 0) * line.scale) >= 1000)));
  const format = (value: number) => unit === "ms" ? formatDuration(value) : unit === "RPS" ? formatRate(value)
    : unit === "%" ? formatPercent(value / 100) : unit === "×" ? formatMultiplier(value)
      : t("results.timeline.valueWithUnit", { value: formatNumber(value), unit: t(`results.units.${unit}`) });
  const sampled = useMemo(() => lines.map((line) => {
    const points: TimelinePoint[] = [];
    for (const [window, metrics] of line.windows.entries()) {
      const raw = metrics[line.metric] ?? null;
      const value = raw === null ? null : raw * line.scale;
      points.push({ window, startMs: metrics.startMs, value });
      // Close each defined segment at the end of its last window, including isolated values before a gap.
      if (window === line.windows.length - 1 || (value !== null && (line.windows[window + 1][line.metric] ?? null) === null)) {
        points.push({ window, startMs: metrics.startMs + metrics.durationMs, value });
      }
    }
    const pixels = Math.max(1, width - 68);
    return { ...line, points: downsample(points, pixels),
      band: line.range === undefined ? [] : replicaBand(line.windows, line.range, line.scale, pixels) };
  }), [lines, width]);
  const active = hoverWindow ?? cursorWindow;
  const lastWindow = Math.ceil(endMs / windowMs) - 1;
  const pointerWindow = (event: { currentTarget: HTMLDivElement; clientX: number }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return windowAt((event.clientX - bounds.left) / bounds.width * endMs, windowMs, endMs);
  };
  const seekByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = cursorWindow ?? 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? lastWindow
      : event.key === "ArrowRight" ? Math.min(lastWindow, current + 1)
        : event.key === "ArrowLeft" ? Math.max(0, current - 1) : null;
    if (next !== null) { event.preventDefault(); onCursor(next); }
  };
  const stateDescription = (band: TimelineStateBand, share: number | null) => share === null ? t("results.timeline.noValue")
    : t("results.timeline.policyWindow", { state: t(`results.timeline.policyValue.${band.state}`), share: formatPercent(share) })
      + (band.state === "circuitOpenShare" && band.copies > 1 ? t("results.timeline.policyCallers", { copies: formatNumber(band.copies) }) : "");
  return <section className="timeline-chart" aria-label={title}>
    <h3>{title} <span>{t("results.unitInParens", { unit: t(durationSeconds ? "results.units.s" : `results.units.${unit}`) })}</span></h3>
    <div className="timeline-plot">
      <ResponsiveContainer width="100%" height={176} minWidth={0} onResize={(next) => setWidth(next)}>
        <ComposedChart margin={{ left: 0, right: 12, top: 12, bottom: 0 }} accessibilityLayer={false}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e7eb" />
          <XAxis type="number" dataKey="startMs" domain={[0, endMs]} allowDataOverflow height={32} tickCount={6}
            tickFormatter={(value: number) => formatNumber(seconds ? value / 1000 : value)} />
          <YAxis width={56} domain={[0, "auto"]} tickFormatter={(value: number) => formatNumber(durationSeconds ? value / 1000 : value)} />
          {regions.map((region, index) => <ReferenceArea key={index} x1={region.fromMs} x2={region.toMs}
            fill={region.kind === "warmup" ? "#94a3b8" : "#f59e0b"} fillOpacity={0.14} />)}
          {sampled.filter(line => line.range !== undefined).map(line => <Area key={`${line.id}:range`}
            data={line.band} dataKey="range" type="stepAfter" name={line.label} fill={line.color} fillOpacity={0.14}
            stroke={line.color} strokeOpacity={0.35} strokeDasharray={line.comparison ? "6 4" : undefined}
            connectNulls={false} dot={false} activeDot={false} isAnimationActive={false} />)}
          {sampled.map((line) => <Line key={line.id} data={line.points} dataKey="value" type="stepAfter"
            name={line.label} stroke={line.color} strokeWidth={1.6} strokeDasharray={line.comparison ? "6 4" : undefined}
            dot={unit === "ms" ? ({ cx, cy, payload, index }: { cx?: number; cy?: number; payload: TimelinePoint; index: number }) =>
              payload.value !== null && payload.startMs === line.windows[payload.window].startMs
                ? line.comparison
                  ? <rect key={index} className="timeline-latency-marker timeline-latency-marker--comparison"
                    x={cx === undefined ? undefined : cx - 2.5} y={cy === undefined ? undefined : cy - 2.5}
                    width={5} height={5} fill="#fff" stroke={line.color} />
                  : <circle key={index} className="timeline-latency-marker" cx={cx} cy={cy} r={2} fill="#fff" stroke={line.color} />
                : <g key={index} /> : false} activeDot={false} connectNulls={false} isAnimationActive={false} />)}
          {thresholds.map((threshold) => <ReferenceLine key={threshold.id} y={threshold.value}
            stroke="#b91c1c" strokeDasharray={threshold.comparison ? "7 3" : "3 3"} ifOverflow="extendDomain" />)}
          {cursorWindow === null ? null : <ReferenceLine x={cursorWindow * windowMs} stroke="#111827" strokeWidth={2} />}
          {hoverWindow === null ? null : <ReferenceLine x={hoverWindow * windowMs} stroke="#475569" strokeDasharray="3 3" />}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="timeline-interaction" role="slider" tabIndex={0} aria-label={t("results.timeline.timeCursor", { title })}
        aria-valuemin={0} aria-valuemax={lastWindow} aria-valuenow={cursorWindow ?? 0}
        aria-valuetext={cursorWindow === null ? t("results.timeline.noPinnedWindow") : t("results.timeline.pinnedWindow", { window: formatNumber(cursorWindow), time: formatDuration(cursorWindow * windowMs) })}
        onPointerMove={(event) => onHover(pointerWindow(event))} onPointerLeave={() => onHover(null)}
        onClick={(event) => onCursor(pointerWindow(event))}
        onKeyDown={seekByKey} />
    </div>
    <p className="timeline-axis">{t(seconds ? "results.timeline.timeAxisSeconds" : "results.timeline.timeAxis")}</p>
    {bands.length === 0 ? null : <div className="timeline-policy-states">
      {bands.map(band => <div key={band.id} className="timeline-policy-state">
        <div>{band.label}</div>
        <div className="timeline-state-band" role="slider" tabIndex={0} aria-label={band.label}
          aria-valuemin={0} aria-valuemax={lastWindow} aria-valuenow={cursorWindow ?? 0}
          aria-valuetext={stateDescription(band, active === null ? null : band.windows[active]?.share ?? null)}
          onPointerMove={event => onHover(pointerWindow(event))} onPointerLeave={() => onHover(null)}
          onClick={event => onCursor(pointerWindow(event))} onKeyDown={seekByKey}>
          <svg viewBox={`0 0 ${endMs || 1} 12`} preserveAspectRatio="none" aria-hidden="true">
            {band.windows.map((window, index) => <rect key={index} data-window={index} data-share={window.share ?? undefined}
              x={window.startMs} width={window.durationMs} y={0} height={12}
              fill={band.state === "circuitOpenShare" ? "#b91c1c" : band.state === "ejectedShare" ? "#b45309" : "#475569"}
              opacity={window.share === null ? 0.03 : 0.06 + 0.84 * Math.min(1, Math.max(0, window.share))}>
              <title>{stateDescription(band, window.share)}</title>
            </rect>)}
            {cursorWindow === null ? null : <line data-cursor-window={cursorWindow} x1={cursorWindow * windowMs} x2={cursorWindow * windowMs}
              y1={0} y2={12} stroke="#111827" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
            {hoverWindow === null ? null : <line x1={hoverWindow * windowMs} x2={hoverWindow * windowMs}
              y1={0} y2={12} stroke="#475569" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <small>{stateDescription(band, active === null ? null : band.windows[active]?.share ?? null)}</small>
      </div>)}
    </div>}
    {unit === "ms" ? <p className="timeline-latency-note">{t("results.timeline.latencyNote")}</p> : null}
    <dl className="timeline-readout">
      {thresholds.map((threshold) => <div key={threshold.id}>
        <dt><span className="timeline-line-key timeline-line-key--comparison" style={{ borderColor: "#b91c1c" }} />{threshold.label}</dt>
        <dd>{formatDuration(threshold.value)}</dd>
      </div>)}
      {lines.map((line) => {
        const raw = active === null ? null : line.windows[active]?.[line.metric] ?? null;
        return <div key={line.id}>
          <dt><span className={`timeline-line-key${line.comparison ? " timeline-line-key--comparison" : ""}${unit === "ms" ? " timeline-line-key--latency" : ""}`}
            style={{ borderColor: line.color }} />{line.label}</dt>
          <dd>{raw === null ? t("results.timeline.noValue") : format(raw * line.scale)}
            {line.range === undefined ? null : <span className="timeline-replica-range">{t("results.timeline.replicaRange", {
              min: active === null || line.windows[active]?.[line.range[0]] == null ? t("results.timeline.noValue") : format(line.windows[active][line.range[0]]! * line.scale),
              max: active === null || line.windows[active]?.[line.range[1]] == null ? t("results.timeline.noValue") : format(line.windows[active][line.range[1]]! * line.scale),
            })}</span>}
          </dd>
        </div>;
      })}
    </dl>
  </section>;
}
