import { Icon } from "../layout/Icon";
import { t } from "../i18n";
import { elementLabel } from "../presentation/labels";
import { observeResize } from "../layout/observeResize";
import { formatNumber } from "../i18n/format";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent, type ReactNode, type Ref, type SetStateAction } from "react";
import { Background, ControlButton, Controls, getViewportForBounds, MiniMap, Panel, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStore } from "@xyflow/react";
import type { AriaLabelConfig, Edge, NodeChange, Rect } from "@xyflow/react";
import type { Catalog, Diagnostic, LayoutFile, ModelFile, Variant } from "../api/apiTypes";
import type { CanvasResults, ConnectionOverlayMetric, NodeOverlayMetric } from "../results/canvasResults";
import { summarizeDiagnostics } from "../validation/diagnostics";
import { elementOf, ownEntry } from "../workspace/params";
import { initialParams } from "../workspace/initialParams";
import { useViewSettings } from "../layout/viewSettings";
import type { EditorCommand } from "../workspace/editor";
import { addBlock, addConnection, connectionRule, insertionPosition, moveBlocks, nextBlockId, positionOf, resizeBlock, setEdgePoints } from "../workspace/structure";
import type { CourseFault } from "../experiment/course";
import { BlockNode } from "./BlockNode";
import type { BlockNodeType } from "./BlockNode";
import { CallEdge, EdgeLayoutProvider } from "./CallEdge";
import { VariantChanges } from "./VariantChanges";
import { canvasPolicyPaths } from "./policyPresentation";
import type { EdgeGeometry } from "./edgeGeometry";
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
  /** Follows result geometry at a minimum 70% zoom until a canvas gesture or page change. */
  focusElement: (id: string, variantId?: string | null) => void;
}

export interface CanvasProps {
  ref?: Ref<CanvasHandle>;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  /** Original model values shown beside the active variant's overrides. */
  baseModel?: ModelFile;
  variant?: Variant;
  modelInfo?: ReactNode;
  /** Model-page results shortcut; its measured overlay height is reserved when fitting the diagram. */
  modelResultsHint?: ReactNode;
  onSelectChange?: (id: string, path: string) => void;
  onModelPage?: () => void;
  overrides?: Record<string, unknown>;
  results?: CanvasResults | null;
  nodeMetric?: NodeOverlayMetric;
  replicaSelection?: { groupId: string; replica: number } | null;
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
  /** Space covered by the open experiment course; fit the diagram above it. Navigation stays above it too. */
  bottomInset?: number;
}

/** The model on a React Flow canvas (ADR 0004); documents and one-command gestures own all edits. */
export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><ModelCanvas {...props} /></ReactFlowProvider>;
}

/** Keep viewport updates outside model rendering; ports inherit their screen-sized hit area from the canvas. */
function CanvasViewport({ ready, onZoomChange }: { ready: boolean; onZoomChange?: (zoom: number) => void }) {
  const zoom = useStore(state => state.transform[2]);
  const container = useStore(state => state.domNode);
  useLayoutEffect(() => { container?.style.setProperty("--port-hit-size", `${12 / zoom}px`); }, [container, zoom]);
  useEffect(() => { if (ready) onZoomChange?.(zoom); }, [ready, zoom, onZoomChange]);
  return null;
}

function ModelCanvas({ ref, model, baseModel, variant, modelInfo, modelResultsHint, onSelectChange, onModelPage, layout, catalog, selected, onSelect, editable = false, parametersEditable = false,
  disabled = false, onCommand, onParam, onValidity, elementDiagnostics, variantElementDiagnostics, onProblems, onZoomChange, overrides = variant?.overrides ?? {}, results = null,
  replicaSelection, nodeMetric = "utilization", connectionMetric = "attemptsPerCall", faults = [], onFault, bottomInset = 0 }: CanvasProps) {
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
  const hint = useRef<HTMLDivElement>(null);
  const hintVisible = modelResultsHint != null;
  const [hintTopInset, setHintTopInset] = useState(0);
  const canvasNode = useStore(state => state.domNode);
  useLayoutEffect(() => {
    const element = hint.current;
    if (element === null || canvasNode === null) return;
    const measure = () => setHintTopInset(element.getBoundingClientRect().bottom - canvasNode.getBoundingClientRect().top + 16);
    measure();
    return observeResize([element], measure);
  }, [hintVisible, canvasNode]);
  const height = useStore((state) => state.height);
  const shortCanvas = height > 0 && height - bottomInset < 240;
  const fitViewOptions = useMemo(() => ({ ...baseFitViewOptions, padding: {
    ...baseFitViewOptions.padding,
    right: shortCanvas ? "252px" as const : baseFitViewOptions.padding.right,
    bottom: `${Math.max(shortCanvas ? 16 : 80, bottomInset + 16)}px` as `${number}px`,
    top: `${Math.max(shortCanvas ? 16 : 64, variantVisible ? bannerHeight + (shortCanvas ? 16 : 48) : 0, hintVisible ? hintTopInset : 0)}px` as `${number}px`,
  } }), [bottomInset, bannerHeight, variantVisible, shortCanvas, hintVisible, hintTopInset]);
  const overridden = (id: string) => Object.keys(overrides).some((path) => path.startsWith(`${id}.`));
  const { screenToFlowPosition, getViewport, getNodes, setViewport } = useReactFlow();
  const manualViewport = useRef(false);
  const [focusTarget, setFocusTarget] = useState<{ id: string; page: string | null } | null>(null);
  if (focusTarget !== null && focusTarget.page !== (variant?.id ?? null)) setFocusTarget(null);
  const width = useStore((state) => state.width);
  const minZoom = useStore(state => state.minZoom);
  const maxZoom = useStore(state => state.maxZoom);
  const initialized = useNodesInitialized();
  const hasNodes = Object.keys(model.blocks).length > 0;
  const [insertions, setInsertions] = useState<{ type: string; center: { x: number; y: number } | null; anchor?: string }[]>([]);
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
    focusElement: (id, page = variant?.id ?? null) => { manualViewport.current = true; setFocusTarget({ id, page }); },
    addBlock: (type) => {
      if (!editable) { structureHint(); return; }
      if (disabled) return;
      const viewport = getViewport();
      const center = width > 0 && height > 0 && (initialized || !hasNodes)
        ? { x: (width / 2 - viewport.x) / viewport.zoom, y: (height / 2 - viewport.y) / viewport.zoom } : null;
      if (catalog.types.some((entry) => entry.id === type && entry.category === "BLOCK")) {
        setInsertions((current) => [...current, { type, center, anchor: selected.find(id => ownEntry(model.blocks, id) !== undefined) }]);
      }
    },
  }));
  if (pending?.center === null && width > 0 && height > 0 && (initialized || !hasNodes)) {
    const viewport = getViewport();
    const center = { x: (width / 2 - viewport.x) / viewport.zoom, y: (height / 2 - viewport.y) / viewport.zoom };
    setInsertions([{ ...pending, center }, ...insertions.slice(1)]);
  }
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [bounds, setBounds] = useState<Rect | null>(null);
  const [edgeGeometries, setEdgeGeometries] = useState<ReadonlyMap<string, EdgeGeometry>>(new Map());
  const onBounds = useCallback((next: Rect | null, geometries: ReadonlyMap<string, EdgeGeometry>) => {
    setBounds(current => current?.x === next?.x && current?.y === next?.y && current?.width === next?.width && current?.height === next?.height ? current : next);
    setEdgeGeometries(geometries);
  }, []);
  const fitDiagram = useCallback(() => {
    if (bounds !== null && width > 0 && height > 0) {
      void setViewport(getViewportForBounds(bounds, width, height, minZoom, maxZoom, fitViewOptions.padding));
    }
  }, [bounds, width, height, minZoom, maxZoom, fitViewOptions, setViewport]);
  useEffect(() => {
    if (!manualViewport.current && insertions.length === 0 && initialized) fitDiagram();
  }, [fitDiagram, initialized, insertions.length]);
  useEffect(() => {
    if (pending === undefined || pending.center === null || measurement?.request !== pending) return;
    // Commit outside ResizeObserver delivery and cancel if the canvas or active document changes first.
    const frame = requestAnimationFrame(() => {
      setInsertions((current) => current.slice(1));
      if (editable && !disabled) {
        const occupied = getNodes().filter((node) => node.id !== pendingId).map((node) => ({ id: node.id, ...node.position,
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
          occupied, size, gridStep, snapToGrid, bounds, occupied.find(node => node.id === pending.anchor));
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
  type Resize = { id: string; x: number; y: number; width: number; height: number; model: ModelFile; layout: LayoutFile | null };
  const resizing = useRef<Resize | null>(null);
  const [resizePreview, setResizePreview] = useState<Resize | null>(null);
  const edgeEditIdentity = useMemo(() => ({ model, layout, variant: variant?.id }), [model, layout, variant?.id]);
  const canResize = editable && !disabled && variant === undefined;
  const activeResize = canResize && resizePreview?.model === model && resizePreview.layout === layout
    && selected.includes(resizePreview.id) ? resizePreview : null;
  if (resizePreview !== null && activeResize === null) setResizePreview(null);
  useLayoutEffect(() => {
    const gesture = resizing.current;
    if (gesture !== null && (!canResize || gesture.model !== model || gesture.layout !== layout || !selected.includes(gesture.id))) resizing.current = null;
  }, [canResize, model, layout, selected]);
  const startResize = useCallback((id: string, value: { x: number; y: number; width: number; height: number }) => {
    if (!canResize) return;
    resizing.current = { id, ...value, model, layout };
  }, [canResize, model, layout]);
  const previewResize = useCallback((id: string, value: { x: number; y: number; width: number; height: number }) => {
    const gesture = resizing.current;
    if (!canResize || gesture?.id !== id || gesture.model !== model || gesture.layout !== layout) return;
    manualViewport.current = true;
    setResizePreview({ ...gesture, ...value });
  }, [canResize, model, layout]);
  const finishResize = useCallback((id: string, value: { x: number; y: number; width: number; height: number }) => {
    const gesture = resizing.current;
    resizing.current = null;
    setResizePreview(null);
    if (!canResize || gesture?.id !== id || gesture.model !== model || gesture.layout !== layout) return;
    if (gesture.x !== value.x || gesture.y !== value.y || gesture.width !== value.width || gesture.height !== value.height) {
      onCommand(resizeBlock(id, { x: value.x, y: value.y }, { width: value.width, height: value.height }));
    }
  }, [canResize, model, layout, onCommand]);
  useEffect(() => {
    const cancel = () => { if (resizing.current !== null) { resizing.current = null; setResizePreview(null); } };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", keydown);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);
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
    position: activeResize?.id === id ? { x: activeResize.x, y: activeResize.y } : id === pendingId && pending?.center != null ? pending.center : ownEntry(moving, id) ?? positionOf(model, layout, id),
    width: activeResize?.id === id ? activeResize.width : layout === null ? undefined : ownEntry(layout.sizes, id)?.width,
    height: activeResize?.id === id ? activeResize.height : layout === null ? undefined : ownEntry(layout.sizes, id)?.height,
    measured: id === pendingId ? pendingSize : ownEntry(sizes, id),
    style: id === pendingId ? { visibility: "hidden" } : undefined,
    selectable: id === pendingId ? false : undefined,
    draggable: id === pendingId ? false : undefined,
    connectable: id === pendingId ? false : undefined,
    focusable: id === pendingId ? false : undefined,
    data: {
      authoredSize: activeResize?.id === id ? { width: activeResize.width, height: activeResize.height } : layout === null ? undefined : ownEntry(layout.sizes, id),
      // React Flow invokes these callbacks only from resize events, never during render.
      // eslint-disable-next-line react-hooks/refs
      onResizeStart: startResize, onResize: previewResize, onResizeEnd: finishResize,
      resizable: id !== pendingId && canResize,
      result: results?.services.get(id),
      resultsPending: results?.pending, resultsEmpty: results?.pending !== undefined && results.window === undefined,
      nodeMetric, selectedReplica: replicaSelection?.groupId === id ? replicaSelection.replica : undefined,
      incomingConnections: incoming.get(id) ?? 0,
      outgoingConnections: outgoing.get(id)?.length ?? 0,
      needsConnection: block.type === "client"
        ? !model.connections.some(connection => connection.from === id && connection.type === "request") : !reachable.has(id),
      faults: faults.filter(fault => fault.elementId === id), onFault,
      onPolicy: (path: string) => { if (!disabled) { if (onSelectChange) onSelectChange(id, path); else onSelect([id]); } },
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
    width: Math.max(node.width ?? 0, node.measured?.width ?? 0), height: Math.max(node.height ?? 0, node.measured?.height ?? 0) }]));
  const [nodeBounds, setNodeBounds] = useState(nextBounds);
  if (nodeBounds.size !== nextBounds.size || [...nextBounds].some(([id, bounds]) => {
    const previous = nodeBounds.get(id);
    return previous === undefined || !Object.is(previous.x, bounds.x) || !Object.is(previous.y, bounds.y) ||
      !Object.is(previous.width, bounds.width) || !Object.is(previous.height, bounds.height);
  })) setNodeBounds(nextBounds);
  useEffect(() => {
    if (focusTarget === null || !initialized || width <= 0 || height <= 0) return;
    const node = nodeBounds.get(focusTarget.id);
    const center = node === undefined ? edgeGeometries.get(focusTarget.id)?.label
      : node.width > 0 && node.height > 0 ? { x: node.x + node.width / 2, y: node.y + node.height / 2 } : undefined;
    if (center === undefined) return;
    // Geometry can arrive after any number of frames; retain focus until the user takes over.
    const frame = requestAnimationFrame(() => {
      const zoom = Math.max(0.7, getViewport().zoom);
      const top = variantVisible ? bannerHeight + 16 : 16;
      void setViewport({ x: width / 2 - center.x * zoom, y: (top + height - bottomInset) / 2 - center.y * zoom, zoom });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget, initialized, nodeBounds, edgeGeometries, width, height, variantVisible, bannerHeight, bottomInset, getViewport, setViewport]);
  const policyRows = new Map<string, number>();
  const edges: Edge[] = model.connections.map((connection) => {
    const targetGroup = Number(ownEntry(model.blocks, connection.to)?.params.replicas ?? 1) > 1;
    const policyRow = policyRows.get(connection.from) ?? 0;
    if (canvasPolicyPaths(connection.type, connection.params, targetGroup).length > 0) policyRows.set(connection.from, policyRow + 1);
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
        edgePoints: layout === null ? undefined : ownEntry(layout.edges, connection.id)?.points,
        routeEditable: canResize, editIdentity: edgeEditIdentity,
        onEdgePoints: (points: { x: number; y: number }[]) => onCommand(setEdgePoints(connection.id, points)),
        onEditStart: () => { manualViewport.current = true; },
        faults: faults.filter(fault => fault.elementId === connection.id), onFault,
        onPolicy: (path: string) => { if (!disabled) { if (onSelectChange) onSelectChange(connection.id, path); else onSelect([connection.id]); } },
        modelParams: baseModel === undefined ? undefined : elementOf(baseModel, connection.id)?.params, overrides,
        resultsPending: results?.pending, resultsEmpty: results?.pending !== undefined && results.window === undefined,
        result: matched, connectionMetric,
        onSelect: (multiple: boolean) => {
          if (!disabled) onSelect(multiple ? selected.includes(connection.id) ? selected.filter(id => id !== connection.id) : [...selected, connection.id] : [connection.id]);
        },
        variantDiagnostics: variantElementDiagnostics?.get(connection.id), onProblems: () => onProblems?.(connection.id),
        windowed: results?.window !== undefined, connection, catalog, diagnostics, overridden: overridden(connection.id), parametersEditable, disabled,
        targetGroup, policyRow,
        onParam: (elementId: string, path: string, value: unknown) => onParam?.(elementId, path, value),
        onValidity: (key: string, valid: boolean) => onValidity?.(key, valid),
      },
      className: summary === null ? undefined : `diagnostic--${summary.severity.toLowerCase()}`,
      selected: selected.includes(connection.id),
      ariaLabel: elementLabel(connection.id, model),
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
    const measurements = changes.flatMap((change) => change.type === "dimensions" && change.resizing === undefined && change.dimensions !== undefined
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
    const resizeIds = new Set(changes.flatMap(change => change.type === "dimensions" && change.resizing !== undefined ? [change.id] : []));
    const positions = changes.flatMap((change) => change.type === "position" && change.position !== undefined
      && change.id !== resizing.current?.id && !resizeIds.has(change.id)
      ? [{ id: change.id, position: change.position, dragging: change.dragging }] : []);
    if (positions.length === 0) return;
    manualViewport.current = true;
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
      onWheelCapture={() => setFocusTarget(null)} onKeyDownCapture={() => setFocusTarget(null)}
      onMouseDownCapture={event => {
        manualViewport.current = true;
        setFocusTarget(null);
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
        <Icon name="lock" size={14} />
        {variantSummary}
      </summary>
      <VariantChanges model={baseModel ?? model} catalog={catalog} overrides={overrides} disabled={disabled} onSelect={onSelectChange} />
    </details>}
    <EdgeLayoutProvider nodes={nodeBounds} connections={model.connections} manual={layout?.edges} onBounds={onBounds}>
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
      onMoveStart={event => { if (event !== null) { manualViewport.current = true; setFocusTarget(null); } }}
      onNodesChange={onNodesChange}
      onEdgesChange={selectionChanges}
      onNodeClick={(event, node) => select(event, node.id)}
      onEdgeClick={(event, edge) => select(event, edge.id)}
      onPaneClick={() => { if (!disabled) onSelect([]); }}
      onDragOver={(event) => {
        if ((!editable && variant === undefined) || disabled) return;
        manualViewport.current = true;
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
      <CanvasViewport ready={initialized || !hasNodes} onZoomChange={onZoomChange} />
      {showGrid && <Background gap={gridStep} />}
      {modelInfo == null && !hintVisible ? null : <Panel position="top-left" className="model-info-position"
        style={{ pointerEvents: "none", top: variantVisible ? bannerHeight + 8 : 0, maxHeight: Math.max(0, height - (variantVisible ? bannerHeight + 48 : 40)) }}>
        <div className="model-info-row">
          {modelInfo}
          {hintVisible ? <div ref={hint} className="model-results-hint nodrag nopan nowheel" role="status">{modelResultsHint}</div> : null}
        </div>
      </Panel>}
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
    <Panel position="bottom-right" className="canvas-navigation" style={{ bottom: bottomInset }} role="group" aria-label={t("editor.canvas.navigation")}
      onWheelCapture={() => { manualViewport.current = true; }}
      onPointerDownCapture={() => { manualViewport.current = true; }}>
      <Controls showInteractive={false} showFitView={false} orientation="horizontal"
        onZoomIn={() => { manualViewport.current = true; }} onZoomOut={() => { manualViewport.current = true; }}>
        <ControlButton className="react-flow__controls-fitview" title={t("editor.canvas.fitView")} aria-label={t("editor.canvas.fitView")}
          onClick={() => { manualViewport.current = true; fitDiagram(); }}>
          <Icon name="fit-view" size={12} />
        </ControlButton>
      </Controls>
      <MiniMap pannable zoomable style={{ width: 120, height: 48 }} />
    </Panel>
    </ReactFlow>
    </EdgeLayoutProvider>
    </div>
  );
}
