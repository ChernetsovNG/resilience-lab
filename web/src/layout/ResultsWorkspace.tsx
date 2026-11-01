import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../i18n";
import { observeResize } from "./observeResize";
import type { ResultsPanelSize, ResultsPanelView } from "./ResultsPanel";
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
export function ResultsWorkspace({ children, view, size: panelSize = "normal", onSizeChange, onShowSelection, analysis, inspector, inspectorSelection = null, inspectorRequest = 0, onInspectorCollapsedChange, canvasFooterHeight = 0 }: {
  children: ReactNode;
  view: ResultsPanelView;
  size?: ResultsPanelSize;
  onSizeChange?: (size: ResultsPanelSize) => void;
  onShowSelection?: () => void;
  analysis: boolean;
  inspector?: ReactNode;
  inspectorSelection?: string | null;
  inspectorRequest?: number;
  onInspectorCollapsedChange?: (collapsed: boolean) => void;
  canvasFooterHeight?: number;
}) {
  const collapsed = panelSize === "collapsed", expanded = panelSize === "expanded";
  const workspace = useRef<HTMLDivElement>(null);
  const inspectorContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (inspectorContent.current !== null) inspectorContent.current.scrollTop = 0;
  }, [analysis, inspectorSelection, inspectorRequest]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [canvasChromeHeight, setCanvasChromeHeight] = useState(0);
  const [heights, setHeights] = useState(storedHeights);
  const [inspectorSize, setInspectorSize] = useState(storedInspector);
  const [lastInspectorRequest, setLastInspectorRequest] = useState(inspectorRequest);
  useEffect(() => {
    onInspectorCollapsedChange?.(inspectorSize.collapsed);
  }, [inspectorSize.collapsed, onInspectorCollapsedChange]);
  if (lastInspectorRequest !== inspectorRequest) {
    setLastInspectorRequest(inspectorRequest);
    if (inspectorSize.collapsed) setInspectorSize(current => ({ ...current, collapsed: false }));
  }
  useLayoutEffect(() => {
    const element = workspace.current!;
    let previous = { width: 0, height: 0 };
    const measure = ({ width, height }: DOMRectReadOnly) => {
      if (previous.width === width && previous.height === height) return;
      previous = { width, height };
      setSize(previous);
    };
    measure(element.getBoundingClientRect());
    return observeResize([element], ([entry]) => measure(entry.contentRect));
  }, []);
  useLayoutEffect(() => {
    if (expanded) return;
    const canvas = workspace.current!.querySelector(".canvas-area");
    if (canvas === null) return;
    const chrome = [...canvas.children].filter(child => !child.classList.contains("canvas"));
    const measure = () => setCanvasChromeHeight(chrome.reduce((height, child) => height + child.getBoundingClientRect().height, 0));
    measure();
    return observeResize([canvas, ...chrome], measure);
  }, [canvasFooterHeight, expanded]);
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
  const minimumCanvas = 160 + canvasFooterHeight + canvasChromeHeight;
  const cramped = available < 160 + minimumCanvas;
  const crampedResults = Math.max(0, Math.min(available / 2, available - canvasChromeHeight - canvasFooterHeight - 80));
  const minimum = cramped ? crampedResults : 160;
  const maximum = cramped ? crampedResults : available - minimumCanvas;
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  const key = (analysis ? "analysis:" : "normal:") + view;
  const fraction = analysis ? 0.62 : view === "timeline" ? 0.55 : 0.32;
  const initialHeight = Math.min(available * fraction, available - (analysis ? 288 : 220) - canvasFooterHeight - canvasChromeHeight);
  const expandedHeight = Math.max(0, available - 32);
  const height = expanded ? expandedHeight : clamp(Math.round(heights[key] ?? initialHeight));
  const resize = (value: number) => {
    if (expanded) {
      if (value >= expandedHeight) return;
      onSizeChange?.("normal");
    }
    setHeights(current => ({ ...current, [key]: clamp(value) }));
  };
  const maximumWidth = Math.max(0, Math.floor(Math.min(size.width / 2, expanded ? size.width : size.width - 48 - 8 - 480)));
  const minimumWidth = Math.min(280, maximumWidth);
  const defaultWidth = Math.max(280, Math.min(480, size.width * 0.22));
  const width = Math.round(Math.max(minimumWidth, Math.min(maximumWidth, inspectorSize.width ?? defaultWidth)));
  const toggleLabel = inspectorSize.collapsed
    ? inspectorSelection === null ? t("editor.inspector.expand") : t("editor.inspector.expandSelected", { selection: inspectorSelection })
    : t("editor.inspector.collapse");
  return <div ref={workspace}
    className={"workspace-panels" + (collapsed ? " workspace-panels--collapsed" : "") + (analysis ? " workspace-panels--analysis" : "") + (expanded ? " workspace-panels--expanded" : "")}
    style={{ "--results-height": height + "px", "--inspector-width": inspectorSize.collapsed ? "2.5rem" : width + "px",
      "--inspector-divider-width": inspectorSize.collapsed ? "0px" : "0.5rem" } as CSSProperties}>
    {children}
    {expanded ? <div className="diagram-strip" role="region" aria-label={t("results.diagram.collapsed")}>
      <span>{t("results.diagram.collapsed")}</span>
      {inspectorSelection === null ? null : <span className="diagram-strip-selection" title={inspectorSelection}>
        {t("results.diagram.selection", { selection: inspectorSelection })}
      </span>}
      <button type="button" onClick={() => onSizeChange?.("normal")}>{t("results.diagram.show")}</button>
      {inspectorSelection === null || onShowSelection === undefined ? null : <button type="button" onClick={() => {
        onSizeChange?.("normal"); onShowSelection();
      }}>{t("results.diagram.showSelection")}</button>}
    </div> : null}
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
      label={t("results.resize.label")} controls="results-panel" value={height} minimum={minimum} maximum={expanded ? expandedHeight : maximum}
      valueText={t("results.resize.height", { height: Math.round(height) })} onChange={resize}
      onOverflow={cramped || expanded ? undefined : () => onSizeChange?.("expanded")}
      onReset={() => onSizeChange?.(expanded ? "normal" : "expanded")} />
  </div>;
}
