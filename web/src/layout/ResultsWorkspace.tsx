import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../i18n";
import type { ResultsPanelView } from "./ResultsPanel";

const storageKey = "resilience-lab.results-panel-heights";

function storedHeights(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
      /^(normal|analysis):(answer|timeline|assumptions|map|problems)$/.test(key) &&
      typeof value === "number" && Number.isFinite(value) && value > 0));
  } catch {
    return {};
  }
}

/** Bounded canvas/results split; browser preferences never enter documents or undo history. */
export function ResultsWorkspace({ children, view, collapsed, analysis }: {
  children: ReactNode;
  view: ResultsPanelView;
  collapsed: boolean;
  analysis: boolean;
}) {
  const workspace = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const [workspaceHeight, setWorkspaceHeight] = useState(0);
  const [heights, setHeights] = useState(storedHeights);
  useLayoutEffect(() => {
    const element = workspace.current!;
    setWorkspaceHeight(element.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => setWorkspaceHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(heights));
    } catch {
      // Private browsing or a full store still permits resizing for this session.
    }
  }, [heights]);
  const available = Math.max(0, workspaceHeight - 8);
  const cramped = available < 380;
  const minimum = cramped ? available / 2 : 160;
  const maximum = cramped ? available / 2 : available - 220;
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  const key = (analysis ? "analysis:" : "normal:") + view;
  const fraction = analysis ? 0.62 : view === "timeline" ? 0.55 : 0.32;
  const height = clamp(Math.round(heights[key] ?? available * fraction));
  const resize = (value: number) => setHeights(current => ({ ...current, [key]: clamp(value) }));
  return <div ref={workspace}
    className={"workspace-panels" + (collapsed ? " workspace-panels--collapsed" : "") + (analysis ? " workspace-panels--analysis" : "")}
    style={{ "--results-height": height + "px" } as CSSProperties}>
    {children}
    <div className="results-divider" role="separator" tabIndex={0} hidden={collapsed}
      aria-label={t("results.resize.label")} aria-orientation="horizontal" aria-controls="results-panel"
      aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(height)}
      aria-valuetext={t("results.resize.height", { height: Math.round(height) })}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, y: event.clientY, height };
      }}
      onPointerMove={event => {
        if (drag.current?.pointer === event.pointerId) resize(drag.current.height + drag.current.y - event.clientY);
      }}
      onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => {
        const next = event.key === "ArrowUp" ? height + 16 : event.key === "ArrowDown" ? height - 16
          : event.key === "Home" ? minimum : event.key === "End" ? maximum : null;
        if (next === null) return;
        event.preventDefault();
        resize(next);
      }} />
  </div>;
}
