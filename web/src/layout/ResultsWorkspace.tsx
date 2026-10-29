import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../i18n";
import type { ResultsPanelView } from "./ResultsPanel";
import { PanelSeparator } from "./PanelSeparator";

const storageKey = "resilience-lab.results-panel-heights";
const inspectorStorageKey = "resilience-lab.inspector";

function storedInspector(): { width?: number; collapsed: boolean } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(inspectorStorageKey) ?? "null");
    if (saved !== null && typeof saved === "object" && !Array.isArray(saved)) {
      const { width, collapsed } = saved as Record<string, unknown>;
      return { width: typeof width === "number" && Number.isFinite(width) && width > 0 ? width : undefined, collapsed: collapsed === true };
    }
  } catch {
    // Private browsing still permits resizing for this session.
  }
  return { collapsed: false };
}

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
export function ResultsWorkspace({ children, view, collapsed, analysis, inspector, inspectorSelection = null }: {
  children: ReactNode;
  view: ResultsPanelView;
  collapsed: boolean;
  analysis: boolean;
  inspector?: ReactNode;
  inspectorSelection?: string | null;
}) {
  const workspace = useRef<HTMLDivElement>(null);
  const inspectorContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (inspectorContent.current !== null) inspectorContent.current.scrollTop = 0;
  }, [analysis, inspectorSelection]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [heights, setHeights] = useState(storedHeights);
  const [inspectorSize, setInspectorSize] = useState(storedInspector);
  useLayoutEffect(() => {
    const element = workspace.current!;
    const measure = ({ width, height }: DOMRectReadOnly) => setSize({ width, height });
    measure(element.getBoundingClientRect());
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect));
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
  useEffect(() => {
    try {
      localStorage.setItem(inspectorStorageKey, JSON.stringify(inspectorSize));
    } catch {
      // Private browsing or a full store still permits resizing for this session.
    }
  }, [inspectorSize]);
  const available = Math.max(0, size.height - 8);
  const cramped = available < 380;
  const minimum = cramped ? available / 2 : 160;
  const maximum = cramped ? available / 2 : available - 220;
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  const key = (analysis ? "analysis:" : "normal:") + view;
  const fraction = analysis ? 0.62 : view === "timeline" ? 0.55 : 0.32;
  const height = clamp(Math.round(heights[key] ?? available * fraction));
  const resize = (value: number) => setHeights(current => ({ ...current, [key]: clamp(value) }));
  const maximumWidth = Math.max(0, Math.min(480, size.width - 48 - 8 - 480));
  const minimumWidth = Math.min(280, maximumWidth);
  const defaultWidth = Math.max(280, Math.min(480, size.width * 0.22));
  const width = Math.round(Math.max(minimumWidth, Math.min(maximumWidth, inspectorSize.width ?? defaultWidth)));
  const toggleLabel = inspectorSize.collapsed
    ? inspectorSelection === null ? t("editor.inspector.expand") : t("editor.inspector.expandSelected", { selection: inspectorSelection })
    : t("editor.inspector.collapse");
  return <div ref={workspace}
    className={"workspace-panels" + (collapsed ? " workspace-panels--collapsed" : "") + (analysis ? " workspace-panels--analysis" : "")}
    style={{ "--results-height": height + "px", "--inspector-width": inspectorSize.collapsed ? "2.5rem" : width + "px",
      "--inspector-divider-width": inspectorSize.collapsed ? "0px" : "0.5rem" } as CSSProperties}>
    {children}
    {inspector === undefined ? null : <>
      <PanelSeparator orientation="vertical" className="inspector-divider" hidden={inspectorSize.collapsed}
        label={t("editor.inspector.resize")} controls="inspector-panel" value={width} minimum={minimumWidth} maximum={maximumWidth}
        valueText={t("editor.inspector.width", { width })} onChange={width => setInspectorSize(current => ({ ...current, width }))}
        onReset={() => setInspectorSize(current => ({ ...current, width: undefined }))} />
      <div id="inspector-panel" className={"inspector-panel" + (inspectorSize.collapsed ? " inspector-panel--collapsed" : "")}>
        <button type="button" className="inspector-toggle" aria-label={toggleLabel} title={toggleLabel}
          aria-expanded={!inspectorSize.collapsed} aria-controls="inspector-content"
          onClick={() => setInspectorSize(current => ({ ...current, collapsed: !current.collapsed }))}>
          <span aria-hidden="true">{t(inspectorSize.collapsed ? "editor.inspector.expandSymbol" : "editor.inspector.collapseSymbol")}</span>
        </button>
        {inspectorSize.collapsed && inspectorSelection !== null ? <span className="inspector-selection" title={inspectorSelection}>{inspectorSelection}</span> : null}
        <div ref={inspectorContent} id="inspector-content" className="inspector-content" hidden={inspectorSize.collapsed}>{inspector}</div>
      </div>
    </>}
    <PanelSeparator orientation="horizontal" className="results-divider" hidden={collapsed}
      label={t("results.resize.label")} controls="results-panel" value={height} minimum={minimum} maximum={maximum}
      valueText={t("results.resize.height", { height: Math.round(height) })} onChange={resize}
      onReset={() => setHeights(current => { const next = { ...current }; delete next[key]; return next; })} />
  </div>;
}
