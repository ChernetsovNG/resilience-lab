import { t } from "../i18n";
import { observeResize } from "../layout/observeResize";
import { formatNumber } from "../i18n/format";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent, type Ref, type SetStateAction } from "react";
import { Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStore } from "@xyflow/react";
import type { AriaLabelConfig, Edge, NodeChange } from "@xyflow/react";
import type { Catalog, Diagnostic, LayoutFile, ModelFile, Variant } from "../api/apiTypes";
import type { CanvasResults, ConnectionOverlayMetric, NodeOverlayMetric } from "../results/canvasResults";
import { summarizeDiagnostics } from "../validation/diagnostics";
import { elementOf, ownEntry } from "../workspace/params";
import { initialParams } from "../workspace/initialParams";
import { useViewSettings } from "../layout/viewSettings";
import type { EditorCommand } from "../workspace/editor";
import { addBlock, addConnection, connectionRule, insertionPosition, moveBlocks, nextBlockId, positionOf } from "../workspace/structure";
import type { CourseFault } from "../experiment/course";
import { BlockNode } from "./BlockNode";
import type { BlockNodeType } from "./BlockNode";
import { CallEdge, EdgeLayoutProvider } from "./CallEdge";
import { VariantChanges } from "./VariantChanges";
import "@xyflow/react/dist/style.css";

const baseFitViewOptions = { padding: { top: "64px" as const, bottom: "80px" as const, left: 0.15, right: 0.15 }, minZoom: 0.05 };
const nodeTypes = { block: BlockNode };
const edgeTypes = { call: CallEdge };
const ariaLabelConfig = (): AriaLabelConfig => ({
  "node.a11yDescription.default": t("editor.canvas.nodeDescription"),
  "node.a11yDescription.keyboardDisabled": t("editor.canvas.nodeKeyboardDescription"),
  "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) => t("editor.canvas.nodeMoved", {
    direction: t(`editor.canvas.direction.${direction}`), x: formatNumber(x), y: formatNumber(y),
  }),
  "edge.a11yDescription.default": t("editor.canvas.edgeDescription"),
  "controls.ariaLabel": t("editor.canvas.controls"),
  "controls.zoomIn.ariaLabel": t("editor.canvas.zoomIn"),
  "controls.zoomOut.ariaLabel": t("editor.canvas.zoomOut"),
  "controls.fitView.ariaLabel": t("editor.canvas.fitView"),
  "controls.interactive.ariaLabel": t("editor.canvas.toggleInteractivity"),
  "minimap.ariaLabel": t("editor.canvas.miniMap"),
  "handle.ariaLabel": t("editor.canvas.handle"),
});

/** Palette activation uses the current viewport, waiting for its first measurement when necessary. */
export interface CanvasHandle {
  addBlock: (type: string) => void;
}

export interface CanvasProps {
  ref?: Ref<CanvasHandle>;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  /** Original model values shown beside the active variant's overrides. */
  baseModel?: ModelFile;
  variant?: Variant;
  onSelectChange?: (id: string, path: string) => void;
  onModelPage?: () => void;
  overrides?: Record<string, unknown>;
  results?: CanvasResults | null;
  nodeMetric?: NodeOverlayMetric;
  connectionMetric?: ConnectionOverlayMetric;
  layout: LayoutFile | null;
  catalog: Catalog;
  selected: string[];
  onSelect: Dispatch<SetStateAction<string[]>>;
  editable?: boolean;
  parametersEditable?: boolean;
  /** Invalid field drafts prevent selection changes as well as structural edits. */
  disabled?: boolean;
  onCommand: (command: EditorCommand) => void;
  onParam?: (id: string, path: string, value: unknown) => void;
  onValidity?: (key: string, valid: boolean) => void;
  elementDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  variantElementDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onProblems?: (id: string) => void;
  faults?: readonly CourseFault[];
  onFault?: (index: number) => void;
  /** Reports viewport zoom after node initialization; an empty model reports immediately. */
  onZoomChange?: (zoom: number) => void;
  /** Space covered by the open experiment course; fit the diagram above it. */
  bottomInset?: number;
}

/** The model on a React Flow canvas (ADR 0004); documents and one-command gestures own all edits. */
export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><ModelCanvas {...props} /></ReactFlowProvider>;
}

function ModelCanvas({ ref, model, baseModel, variant, onSelectChange, onModelPage, layout, catalog, selected, onSelect, editable = false, parametersEditable = false,
  disabled = false, onCommand, onParam, onValidity, elementDiagnostics, variantElementDiagnostics, onProblems, onZoomChange, overrides = variant?.overrides ?? {}, results = null,
  nodeMetric = "utilization", connectionMetric = "amplification", faults = [], onFault, bottomInset = 0 }: CanvasProps) {
  const { gridStep, snapToGrid, showGrid } = useViewSettings();
  const variantVisible = variant !== undefined;
  const banner = useRef<HTMLDetailsElement>(null);
  const [bannerHeight, setBannerHeight] = useState(0);
  useLayoutEffect(() => {
    const element = banner.current;
    if (element === null) return;
    const measure = () => setBannerHeight(element.getBoundingClientRect().height);
    measure();
    return observeResize([element], measure);
  }, [variant?.id]);
  const height = useStore((state) => state.height);
  const shortCanvas = height > 0 && height < 240;
  const fitViewOptions = useMemo(() => ({ ...baseFitViewOptions, padding: {
    ...baseFitViewOptions.padding,
    right: shortCanvas ? "252px" as const : baseFitViewOptions.padding.right,
    bottom: `${Math.max(shortCanvas ? 16 : 80, bottomInset + 16)}px` as `${number}px`,
    top: `${Math.max(shortCanvas ? 16 : 64, variantVisible ? bannerHeight + (shortCanvas ? 16 : 48) : 0)}px` as `${number}px`,
  } }), [bottomInset, bannerHeight, variantVisible, shortCanvas]);
  const overridden = (id: string) => Object.keys(overrides).some((path) => path.startsWith(`${id}.`));
  const { screenToFlowPosition, fitView, getViewport, getNodes, setViewport } = useReactFlow();
  const manualViewport = useRef(false);
  const width = useStore((state) => state.width);
  const zoom = useStore((state) => state.transform[2]);
  const initialized = useNodesInitialized();
  const hasNodes = Object.keys(model.blocks).length > 0;
  const [insertions, setInsertions] = useState<{ type: string; center: { x: number; y: number } | null }[]>([]);
  const [measurement, setMeasurement] = useState<{
    request: (typeof insertions)[number]; size: { width: number; height: number };
  } | null>(null);
  const pending = insertions[0];
  const pendingId = pending?.center == null ? null : nextBlockId(model, pending.type);
  const pendingSize = measurement !== null && measurement.request === pending ? measurement.size : undefined;
  const [notice, setNotice] = useState<{ readonly message: string | null; variant?: string } | null>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const structureHint = () => {
    if (variant !== undefined && !disabled) setNotice({ variant: variant.id,
      get message() { return t("editor.variant.structureHint"); } });
  };
  useImperativeHandle(ref, () => ({
    addBlock: (type) => {
      if (!editable) { structureHint(); return; }
      if (disabled) return;
      const viewport = getViewport();
      const center = width > 0 && height > 0 && (initialized || !hasNodes)
        ? { x: (width / 2 - viewport.x) / viewport.zoom, y: (height / 2 - viewport.y) / viewport.zoom } : null;
      if (catalog.types.some((entry) => entry.id === type && entry.category === "BLOCK")) {
        setInsertions((current) => [...current, { type, center }]);
      }
    },
  }));
  if (pending?.center === null && width > 0 && height > 0 && (initialized || !hasNodes)) {
    const viewport = getViewport();
    const center = { x: (width / 2 - viewport.x) / viewport.zoom, y: (height / 2 - viewport.y) / viewport.zoom };
    setInsertions([{ ...pending, center }, ...insertions.slice(1)]);
  }
  useEffect(() => {
    if (initialized || !hasNodes) onZoomChange?.(zoom);
  }, [initialized, hasNodes, zoom, onZoomChange]);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  useEffect(() => {
    if (!manualViewport.current && insertions.length === 0 && initialized && width > 0 && height > 0) void fitView(fitViewOptions);
  }, [fitView, fitViewOptions, initialized, width, height, sizes, insertions.length]);
  useEffect(() => {
    if (pending === undefined || pending.center === null || measurement?.request !== pending) return;
    // Commit outside ResizeObserver delivery and cancel if the canvas or active document changes first.
    const frame = requestAnimationFrame(() => {
      setInsertions((current) => current.slice(1));
      if (editable && !disabled) {
        const occupied = getNodes().filter((node) => node.id !== pendingId).map((node) => ({ ...node.position,
          width: node.measured?.width ?? 0, height: node.measured?.height ?? 0 }));
        const viewport = getViewport();
        const size = measurement.size;
        const available = { width: Math.max(1, width - 32), height: Math.max(1, height - bottomInset - 32) };
        const zoom = Math.min(viewport.zoom, available.width / size.width, available.height / size.height);
        const center = { x: (width / 2 - viewport.x) / viewport.zoom,
          y: ((height - bottomInset) / 2 - viewport.y) / viewport.zoom };
        const bounds = { x: center.x - available.width / zoom / 2, y: center.y - available.height / zoom / 2,
          width: available.width / zoom, height: available.height / zoom };
        const position = insertionPosition({ x: center.x - size.width / 2, y: center.y - size.height / 2 },
          occupied, size, gridStep, snapToGrid, bounds);
        manualViewport.current = true;
        onCommand(addBlock(catalog, pending.type, position));
        if (zoom !== viewport.zoom || position.x < bounds.x || position.y < bounds.y ||
          position.x + size.width > bounds.x + bounds.width || position.y + size.height > bounds.y + bounds.height) {
          void setViewport({ zoom, x: width / 2 - (position.x + size.width / 2) * zoom,
            y: (height - bottomInset) / 2 - (position.y + size.height / 2) * zoom });
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pending, pendingId, measurement, editable, disabled, catalog, getNodes, getViewport, setViewport, onCommand, gridStep, snapToGrid, width, height, bottomInset]);
  const [moving, setMoving] = useState<LayoutFile["positions"]>({});
  const blocks = Object.entries(model.blocks);
  // Measure the actual new node before issuing its single document command; previews never enter history.
  if (pending !== undefined && pendingId !== null) blocks.push([pendingId, { type: pending.type, params: initialParams(catalog.types.find(type => type.id === pending.type)?.params ?? []) }]);
  const connected = new Set(model.connections.filter(connection => selected.includes(connection.id))
    .flatMap(connection => [connection.from, connection.to]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const connection of model.connections) {
    incoming.set(connection.to, (incoming.get(connection.to) ?? 0) + 1);
    outgoing.set(connection.from, [...(outgoing.get(connection.from) ?? []), connection.to]);
  }
  // A missing request is a global diagnostic, so disconnected-node hints also follow the draft's structure.
  const reachable = new Set(blocks.filter(([, block]) => block.type === "client").map(([id]) => id));
  for (const id of reachable) for (const target of outgoing.get(id) ?? []) reachable.add(target);
  const nodes: BlockNodeType[] = blocks.map(([id, block]) => ({
    id,
    type: "block",
    position: id === pendingId && pending?.center != null ? pending.center : ownEntry(moving, id) ?? positionOf(model, layout, id),
    measured: id === pendingId ? pendingSize : ownEntry(sizes, id),
    style: id === pendingId ? { visibility: "hidden" } : undefined,
    selectable: id === pendingId ? false : undefined,
    draggable: id === pendingId ? false : undefined,
    connectable: id === pendingId ? false : undefined,
    focusable: id === pendingId ? false : undefined,
    data: {
      result: results?.services.get(id),
      resultsPending: results?.pending, resultsEmpty: results?.pending !== undefined && results.window === undefined,
      nodeMetric,
      incomingConnections: incoming.get(id) ?? 0,
      outgoingConnections: outgoing.get(id)?.length ?? 0,
      needsConnection: block.type === "client"
        ? !model.connections.some(connection => connection.from === id && connection.type === "request") : !reachable.has(id),
      faults: faults.filter(fault => fault.elementId === id), onFault,
      id, block, modelBlock: baseModel === undefined ? undefined : ownEntry(baseModel.blocks, id), overrides,
      catalog, overridden: overridden(id), diagnostics: elementDiagnostics?.get(id),
      variantDiagnostics: variantElementDiagnostics?.get(id), onProblems: () => onProblems?.(id),
      ports: catalog.types.find((type) => type.id === block.type)?.ports ?? [],
      editable: id !== pendingId && editable, parametersEditable, disabled: id === pendingId || disabled,
      onParam: (elementId, path, value) => onParam?.(elementId, path, value),
      onValidity: (key, valid) => onValidity?.(key, valid),
    },
    selected: id !== pendingId && selected.includes(id),
    className: connected.has(id) ? "canvas-node--connected" : undefined,
    ariaLabel: id,
    domAttributes: { "aria-roledescription": t("editor.canvas.nodeRole"), "aria-hidden": id === pendingId ? true : undefined },
  }));
  const nextBounds = new Map(nodes.filter(node => node.id !== pendingId).map(node => [node.id, { ...node.position,
    width: node.measured?.width ?? 0, height: node.measured?.height ?? 0 }]));
  const [nodeBounds, setNodeBounds] = useState(nextBounds);
  if (nodeBounds.size !== nextBounds.size || [...nextBounds].some(([id, bounds]) => {
    const previous = nodeBounds.get(id);
    return previous === undefined || !Object.is(previous.x, bounds.x) || !Object.is(previous.y, bounds.y) ||
      !Object.is(previous.width, bounds.width) || !Object.is(previous.height, bounds.height);
  })) setNodeBounds(nextBounds);
  const edges: Edge[] = model.connections.map((connection) => {
    const result = results?.connections.get(connection.id);
    const matched = result?.from === connection.from && result.to === connection.to && result.type === connection.type
      ? result : undefined;
    const diagnostics = elementDiagnostics?.get(connection.id) ?? [];
    const summary = summarizeDiagnostics(diagnostics);
    return {
      id: connection.id,
      type: "call",
      source: connection.from,
      target: connection.to,
      sourceHandle: catalog.types.find((type) => type.id === model.blocks[connection.from]?.type)?.ports.find((port) => port.direction === "OUT")?.id,
      targetHandle: catalog.types.find((type) => type.id === model.blocks[connection.to]?.type)?.ports.find((port) => port.direction === "IN")?.id,
      data: {
        faults: faults.filter(fault => fault.elementId === connection.id), onFault,
        modelParams: baseModel === undefined ? undefined : elementOf(baseModel, connection.id)?.params, overrides,
        resultsPending: results?.pending, resultsEmpty: results?.pending !== undefined && results.window === undefined,
        result: matched, connectionMetric,
        onSelect: (multiple: boolean) => {
          if (!disabled) onSelect(multiple ? selected.includes(connection.id) ? selected.filter(id => id !== connection.id) : [...selected, connection.id] : [connection.id]);
        },
        variantDiagnostics: variantElementDiagnostics?.get(connection.id), onProblems: () => onProblems?.(connection.id),
        windowed: results?.window !== undefined, connection, catalog, diagnostics, overridden: overridden(connection.id), parametersEditable, disabled,
        targetGroup: Number(ownEntry(model.blocks, connection.to)?.params.replicas ?? 1) > 1,
        onParam: (elementId: string, path: string, value: unknown) => onParam?.(elementId, path, value),
        onValidity: (key: string, valid: boolean) => onValidity?.(key, valid),
      },
      className: summary === null ? undefined : `diagnostic--${summary.severity.toLowerCase()}`,
      selected: selected.includes(connection.id),
      ariaLabel: connection.id,
      domAttributes: { "aria-roledescription": t("editor.canvas.edgeRole") },
    };
  });

  const select = (event: MouseEvent, id: string) => {
    if (disabled) return;
    const multiple = event.ctrlKey || event.metaKey || event.shiftKey;
    onSelect(multiple ? selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id] : [id]);
  };
  const selectionChanges = (changes: { type: string; id?: string; selected?: boolean }[]) => {
    const selections = changes.filter((change) => change.type === "select");
    if (disabled || selections.length === 0) return;
    onSelect((current) => {
      const next = new Set(current);
      for (const change of selections) {
        if (change.selected) next.add(change.id!);
        else next.delete(change.id!);
      }
      return [...next];
    });
  };
  const onNodesChange = (changes: NodeChange<BlockNodeType>[]) => {
    selectionChanges(changes);
    const measurements = changes.flatMap((change) => change.type === "dimensions" && change.dimensions !== undefined
      ? [[change.id, change.dimensions] as const] : []);
    if (measurements.length > 0) setSizes((current) => {
      const changed = measurements.filter(([id, size]) => ownEntry(current, id)?.width !== size.width || ownEntry(current, id)?.height !== size.height);
      return changed.length === 0 ? current : { ...current, ...Object.fromEntries(changed) };
    });
    const incoming = measurements.find(([id]) => id === pendingId)?.[1];
    if (pending !== undefined && incoming !== undefined && incoming.width > 0 && incoming.height > 0) {
      setMeasurement({ request: pending, size: incoming });
    }
    if (!editable) {
      if (changes.some(change => change.type === "position")) structureHint();
      return;
    }
    const positions = changes.flatMap((change) => change.type === "position" && change.position !== undefined
      ? [{ id: change.id, position: change.position, dragging: change.dragging }] : []);
    if (positions.length === 0) return;
    setMoving((current) => {
      const next = { ...current };
      for (const change of positions) {
        if (change.dragging) next[change.id] = change.position;
        else delete next[change.id];
      }
      return next;
    });
    // React Flow uses dragging=false for both gesture completion and keyboard movement.
    const settled = positions.filter((change) => !change.dragging);
    if (settled.length > 0) onCommand(moveBlocks(Object.fromEntries(settled.map((change) => [change.id, change.position]))));
  };

  const count = Object.keys(overrides).length;
  const variantSummary = variant === undefined ? "" : t("editor.variant.banner", { name: variant.label ?? variant.id,
    count: t(count === 1 ? "editor.variant.changeCountOne" : "editor.variant.changeCount", { count: formatNumber(count) }) });
  return (
    <div className={`model-canvas${variant === undefined ? "" : " variant-canvas"}`}
      onMouseDownCapture={event => {
        if (variant === undefined || disabled || !(event.target instanceof Element)
          || event.target.closest("button, input, textarea, select, .inline-param") !== null
          || event.target.closest(".react-flow__node, .react-flow__handle") === null) return;
        gesture.current = { x: event.clientX, y: event.clientY };
        event.stopPropagation();
      }}
      onMouseMoveCapture={event => {
        const start = gesture.current;
        if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
          gesture.current = null;
          structureHint();
        }
      }}
      onMouseUpCapture={() => { gesture.current = null; }} onMouseLeave={() => { gesture.current = null; }}>
    {variant === undefined ? null : <details ref={banner} key={variant.id} className="variant-banner" data-testid="variant-banner">
      <summary title={variantSummary}>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor">
          <rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" />
        </svg>
        {variantSummary}
      </summary>
      <VariantChanges model={baseModel ?? model} catalog={catalog} overrides={overrides} disabled={disabled} onSelect={onSelectChange} />
    </details>}
    <EdgeLayoutProvider nodes={nodeBounds} connections={model.connections}>
    <ReactFlow
      aria-label={t("editor.canvas.label")}
      ariaLabelConfig={ariaLabelConfig()}
      proOptions={{ hideAttribution: true }}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitViewOptions={fitViewOptions}
      minZoom={0.05}
      snapToGrid={snapToGrid}
      snapGrid={[gridStep, gridStep]}
      nodesDraggable={editable}
      nodesConnectable={editable}
      elementsSelectable={!disabled}
      deleteKeyCode={null}
      onMoveStart={event => { if (event !== null) manualViewport.current = true; }}
      onNodesChange={onNodesChange}
      onEdgesChange={selectionChanges}
      onNodeClick={(event, node) => select(event, node.id)}
      onEdgeClick={(event, edge) => select(event, edge.id)}
      onPaneClick={() => { if (!disabled) onSelect([]); }}
      onDragOver={(event) => {
        if ((!editable && variant === undefined) || disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!editable) { structureHint(); return; }
        if (disabled) return;
        const type = event.dataTransfer.getData("application/resilience-lab-block");
        const point = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid });
        onCommand(addBlock(catalog, type, point));
      }}
      onConnect={({ source, target, sourceHandle, targetHandle }) => {
        if (!editable) { structureHint(); return; }
        const rule = connectionRule(catalog, model, source, target, sourceHandle, targetHandle);
        setNotice(rule.error === null ? null : { get message() {
          return connectionRule(catalog, model, source, target, sourceHandle, targetHandle).error;
        } });
        if (rule.type !== null) onCommand(addConnection(catalog, source, target, sourceHandle, targetHandle));
      }}
      onConnectEnd={(_, connection) => {
        if (!editable) return;
        if (connection.fromNode !== null && connection.isValid !== true) setNotice({ get message() { return t("editor.canvas.connectionHint"); } });
      }}
    >
      {showGrid && <Background gap={gridStep} />}
      <Panel position="bottom-right" className="react-flow__attribution">
        <a href={`https://reactflow.dev${import.meta.env.PROD ? "?utm_source=attribution" : "/attribution"}`} target="_blank" rel="noopener noreferrer"
          aria-label={t("editor.canvas.attributionLabel")}>{t("editor.canvas.attribution")}</a>
      </Panel>
      {notice === null || (notice.variant !== undefined && notice.variant !== variant?.id) ? null
        : <div className="canvas-notice" role="alert"
          style={notice.variant === undefined ? undefined : { top: bannerHeight + 16, zIndex: 1003 }}>
          {notice.message}{notice.variant === undefined ? null : <>
          {" "}<a href="#model" onClick={event => { event.preventDefault(); setNotice(null); onModelPage?.(); }}>{t("editor.pages.model")}</a>
        </>}</div>}
    <Panel position="bottom-right" className="canvas-navigation" role="group" aria-label={t("editor.canvas.navigation")}
      onWheelCapture={() => { manualViewport.current = true; }}
      onPointerDownCapture={() => { manualViewport.current = true; }}>
      <Controls showInteractive={false} orientation="horizontal" fitViewOptions={fitViewOptions}
        onZoomIn={() => { manualViewport.current = true; }} onZoomOut={() => { manualViewport.current = true; }}
        onFitView={() => { manualViewport.current = true; }} />
      <MiniMap pannable zoomable style={{ width: 120, height: 48 }} />
    </Panel>
    </ReactFlow>
    </EdgeLayoutProvider>
    </div>
  );
}
