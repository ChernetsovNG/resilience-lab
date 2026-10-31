import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Catalog, ExperimentFile, ModelFile } from "../api/apiTypes";
import { t } from "../i18n";
import { observeResize } from "../layout/observeResize";
import { formatDuration, formatNumber, formatRate } from "../i18n/format";
import { PanelSeparator } from "../layout/PanelSeparator";
import { windowAt } from "../results/timeline/data";
import { courseData, runConditions } from "./course";
import "./course.css";

const storageKey = "resilience-lab.experiment-course";
function preference(): { open: boolean; height: number } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved !== null && typeof saved === "object") {
      const { open, height } = saved as Record<string, unknown>;
      return { open: open === true, height: typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 220 };
    }
  } catch { /* Browser storage is optional. */ }
  return { open: false, height: 220 };
}

/** A document preview on every experiment page; expanded content overlays the canvas to preserve its space. */
export function ExperimentCourse({ model, experiment, catalog, onFault, disabled = false, cursorWindow = null, windowMs = 1, onCursorChange, onHeightChange }: {
  model: ModelFile;
  experiment: ExperimentFile;
  catalog: Catalog;
  onFault: (index: number) => void;
  disabled?: boolean;
  cursorWindow?: number | null;
  windowMs?: number;
  onCursorChange?: (window: number | null) => void;
  onHeightChange?: (height: number) => void;
}) {
  const [saved, setSaved] = useState(preference);
  const [maximum, setMaximum] = useState(360);
  const root = useRef<HTMLElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (parent == null) return;
    const measure = () => {
      const height = parent.querySelector(".canvas")?.getBoundingClientRect().height ?? 0;
      if (height > 0) setMaximum(Math.max(0, Math.min(360, height - 120)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    return observeResize([parent], measure);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Session controls remain usable. */ }
  }, [saved]);
  const minimum = Math.min(128, maximum);
  const height = Math.max(minimum, Math.min(maximum, saved.height));
  useEffect(() => {
    onHeightChange?.(saved.open ? height : 0);
    return () => onHeightChange?.(0);
  }, [saved.open, height, onHeightChange]);
  const data = courseData(model, experiment, catalog);
  const conditions = runConditions(model, experiment, catalog);
  const x = (timeMs: number) => Math.max(0, Math.min(100, timeMs / (data.endMs || 1) * 100));
  const time = (timeMs: number) => formatDuration(timeMs / 1000, "s");
  const seek = (timeMs: number) => onCursorChange?.(windowAt(timeMs, windowMs, data.endMs));
  return <section className="experiment-course" ref={root} aria-label={t("course.title")}>
    <button type="button" className="course-toggle" aria-label={t("course.title")} title={conditions}
      aria-expanded={saved.open} aria-controls={id} onClick={() => setSaved(current => ({ ...current, open: !current.open }))}>
      <span aria-hidden="true">{t(saved.open ? "course.collapseSymbol" : "course.expandSymbol")}</span>
      <strong>{t("course.title")}</strong><span className="course-overview">{conditions}</span>
    </button>
    <div id={id} className="course-expanded" hidden={!saved.open} style={{ height }}>
      <PanelSeparator orientation="horizontal" className="course-divider" label={t("course.resize")} controls={id}
        value={height} minimum={minimum} maximum={maximum} valueText={t("course.height", { height: formatNumber(height) })}
        onChange={height => setSaved(current => ({ ...current, height }))}
        onReset={() => setSaved(current => ({ ...current, height: 220 }))} />
      <div className="course-content">
        <div className="course-plot">
          <div className="course-phases">
            {data.warmupMs > 0 ? <span data-phase="warmup" data-to-ms={data.warmupMs} style={{ width: `${x(data.warmupMs)}%` }}
              title={t("course.phase", { phase: t("editor.run.warmup"), from: time(0), to: time(data.warmupMs) })}>{t("editor.run.warmup")}</span> : null}
            <span data-phase="measurement" data-to-ms={data.endMs} style={{ width: `${100 - x(data.warmupMs)}%` }}
              title={t("course.phase", { phase: t("editor.run.measurement"), from: time(data.warmupMs), to: time(data.endMs) })}>{t("editor.run.measurement")}</span>
          </div>
          {data.loads.map(load => {
            const maximumRate = Math.max(1, ...load.points.map(point => point.rate));
            const y = (rate: number) => 64 - rate / maximumRate * 40;
            return <figure className="course-load" key={load.id}>
              <figcaption>{load.id}</figcaption>
              <svg viewBox="0 0 1000 72" preserveAspectRatio="none" role="img" aria-label={t("course.intensity", { client: load.id })}>
                <polyline points={load.points.map(point => `${x(point.timeMs) * 10},${y(point.rate)}`).join(" ")}
                  fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </svg>
              {load.points.length === 0 ? <span>{t("course.invalidLoad")}</span> : load.points.map(point => <span className="course-load-point" key={point.timeMs}
                style={{ left: `${x(point.timeMs)}%`, top: y(point.rate),
                  transform: `translateX(${point.timeMs === 0 ? 0 : point.timeMs === data.endMs ? -100 : -50}%)` }}
                title={t("course.point", { time: time(point.timeMs), rate: formatRate(point.rate) })}>{formatRate(point.rate)}</span>)}
            </figure>;
          })}
          {data.faults.map(fault => <button className="course-fault" type="button" key={fault.index} disabled={disabled}
            title={t("course.openFault", { fault: fault.label })} aria-label={fault.label} onClick={() => onFault(fault.index)}>
            {fault.fromMs === null || fault.toMs === null ? null : <span className="course-fault-interval" aria-hidden="true"
              style={{ left: `${x(fault.fromMs)}%`, width: `${Math.max(0, x(fault.toMs) - x(fault.fromMs))}%` }} />}
            <span className="course-fault-label">{fault.label}</span>
          </button>)}
          <div className={`course-axis${onCursorChange === undefined ? "" : " course-axis--interactive"}`}
            role={onCursorChange === undefined ? undefined : "slider"} tabIndex={onCursorChange === undefined ? undefined : 0}
            aria-label={onCursorChange === undefined ? undefined : t("course.time")}
            aria-valuemin={onCursorChange === undefined ? undefined : 0} aria-valuemax={onCursorChange === undefined ? undefined : data.endMs / 1000}
            aria-valuenow={onCursorChange === undefined ? undefined : (cursorWindow ?? 0) * windowMs / 1000}
            aria-valuetext={onCursorChange === undefined ? undefined : time((cursorWindow ?? 0) * windowMs)}
            onClick={event => {
              if (onCursorChange === undefined) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (bounds.width > 0) seek((event.clientX - bounds.left) / bounds.width * data.endMs);
            }}
            onKeyDown={event => {
              const next = event.key === "ArrowLeft" ? (cursorWindow ?? 0) - 1 : event.key === "ArrowRight" ? (cursorWindow ?? 0) + 1
                : event.key === "Home" ? 0 : event.key === "End" ? Math.ceil(data.endMs / windowMs) - 1 : null;
              if (next === null || onCursorChange === undefined) return;
              event.preventDefault(); seek(next * windowMs);
            }}>
            {[0, 0.25, 0.5, 0.75, 1].map(fraction => <span key={fraction}>{time(fraction * data.endMs)}</span>)}
          </div>
          {cursorWindow === null || onCursorChange === undefined ? null : <div className="course-cursor" data-testid="course-cursor"
            data-cursor-window={cursorWindow} style={{ left: `${x(cursorWindow * windowMs)}%` }} />}
        </div>
      </div>
    </div>
  </section>;
}
