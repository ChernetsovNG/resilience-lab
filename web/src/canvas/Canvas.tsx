import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { useEffect, useImperativeHandle, useState, type Dispatch, type MouseEvent, type Ref, type SetStateAction } from "react";
import { Background, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStore } from "@xyflow/react";
import type { AriaLabelConfig, Edge, NodeChange } from "@xyflow/react";
import type { Catalog, Diagnostic, LayoutFile, ModelFile } from "../api/apiTypes";
import type { CanvasResults, NodeOverlayMetric } from "../results/canvasResults";
import { summarizeDiagnostics } from "../validation/diagnostics";
import { ownEntry } from "../workspace/params";
import type { EditorCommand } from "../workspace/editor";
import { addBlock, addConnection, connectionRule, insertionPosition, moveBlocks, nextBlockId, positionOf } from "../workspace/structure";
import { BlockNode } from "./BlockNode";
import type { BlockNodeType } from "./BlockNode";
import { CallEdge } from "./CallEdge";
import "@xyflow/react/dist/style.css";

const nodeTypes = { block: BlockNode };
const edgeTypes = { call: CallEdge };
const ariaLabelConfig: AriaLabelConfig = {
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
};

/** Palette activation places a block using the canvas viewport at the moment of activation. */
export interface CanvasHandle {
  addBlock: (type: string) => void;
}

export interface CanvasProps {
  ref?: Ref<CanvasHandle>;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  overrides?: Record<string, unknown>;
  results?: CanvasResults | null;
  nodeMetric?: NodeOverlayMetric;
  /** Upper bound of the color legend, in the selected metric's units. */
  nodeMetricMaximum?: number;
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
  /** Reports viewport zoom after node initialization; an empty model reports immediately. */
  onZoomChange?: (zoom: number) => void;
}

/** The model on a React Flow canvas (ADR 0004); documents and one-command gestures own all edits. */
export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><ModelCanvas {...props} /></ReactFlowProvider>;
}

function ModelCanvas({ ref, model, layout, catalog, selected, onSelect, editable = false, parametersEditable = false,
  disabled = false, onCommand, onParam, onValidity, elementDiagnostics, onZoomChange, overrides = {}, results = null,
  nodeMetric = "utilization", nodeMetricMaximum = 1 }: CanvasProps) {
  const overridden = (id: string) => Object.keys(overrides).some((path) => path.startsWith(`${id}.`));
  const { screenToFlowPosition, fitView, getViewport, getNodes } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const zoom = useStore((state) => state.transform[2]);
  const [insertions, setInsertions] = useState<{ type: string; center: { x: number; y: number } }[]>([]);
  const [measurement, setMeasurement] = useState<{
    request: (typeof insertions)[number]; size: { width: number; height: number };
  } | null>(null);
  const pending = insertions[0];
  const pendingId = pending === undefined ? null : nextBlockId(model, pending.type);
  const pendingSize = measurement !== null && measurement.request === pending ? measurement.size : undefined;
  useImperativeHandle(ref, () => ({
    addBlock: (type) => {
      if (!editable || disabled || width <= 0 || height <= 0) return;
      const viewport = getViewport();
      const center = { x: (width / 2 - viewport.x) / viewport.zoom, y: (height / 2 - viewport.y) / viewport.zoom };
      if (catalog.types.some((entry) => entry.id === type && entry.category === "BLOCK")) {
        setInsertions((current) => [...current, { type, center }]);
      }
    },
  }));
  const initialized = useNodesInitialized();
  const hasNodes = Object.keys(model.blocks).length > 0;
  useEffect(() => {
    if (initialized || !hasNodes) onZoomChange?.(zoom);
  }, [initialized, hasNodes, zoom, onZoomChange]);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  useEffect(() => {
    if (insertions.length === 0 && initialized && width > 0 && height > 0) void fitView({ padding: 0.15, minZoom: 0.05 });
  }, [fitView, initialized, width, height, sizes, insertions.length]);
  useEffect(() => {
    if (pending === undefined || measurement?.request !== pending) return;
    // Commit outside ResizeObserver delivery and cancel if the canvas or active document changes first.
    const frame = requestAnimationFrame(() => {
      setInsertions((current) => current.slice(1));
      if (editable && !disabled) {
        const occupied = getNodes().filter((node) => node.id !== pendingId).map((node) => ({ ...node.position,
          width: node.measured?.width ?? 0, height: node.measured?.height ?? 0 }));
        onCommand(addBlock(catalog, pending.type, insertionPosition(pending.center, occupied, measurement.size)));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pending, pendingId, measurement, editable, disabled, catalog, getNodes, onCommand]);
  const [moving, setMoving] = useState<LayoutFile["positions"]>({});
  const [notice, setNotice] = useState<string | null>(null);
  const blocks = Object.entries(model.blocks);
  // Measure the actual new node before issuing its single document command; previews never enter history.
  if (pending !== undefined && pendingId !== null) blocks.push([pendingId, { type: pending.type, params: {} }]);
  const nodes: BlockNodeType[] = blocks.map(([id, block]) => ({
    id,
    type: "block",
    position: id === pendingId && pending !== undefined ? pending.center : ownEntry(moving, id) ?? positionOf(model, layout, id),
    measured: id === pendingId ? pendingSize : ownEntry(sizes, id),
    style: id === pendingId ? { visibility: "hidden" } : undefined,
    selectable: id === pendingId ? false : undefined,
    draggable: id === pendingId ? false : undefined,
    connectable: id === pendingId ? false : undefined,
    focusable: id === pendingId ? false : undefined,
    data: {
      result: block.type === "service" ? results?.services.get(id) : undefined,
      nodeMetric, nodeMetricMaximum,
      id, block, catalog, overridden: overridden(id), diagnostics: elementDiagnostics?.get(id),
      ports: catalog.types.find((type) => type.id === block.type)?.ports ?? [],
      editable: id !== pendingId && editable, parametersEditable: id !== pendingId && parametersEditable, disabled: id === pendingId || disabled,
      onParam: (elementId, path, value) => onParam?.(elementId, path, value),
      onValidity: (key, valid) => onValidity?.(key, valid),
    },
    selected: id !== pendingId && selected.includes(id),
    ariaLabel: id,
    domAttributes: { "aria-roledescription": t("editor.canvas.nodeRole"), "aria-hidden": id === pendingId ? true : undefined },
  }));
  const edges: Edge[] = model.connections.map((connection) => {
    const result = results?.connections.get(connection.id);
    const amplification = result?.from === connection.from && result.to === connection.to && result.type === connection.type
      ? result.amplification : undefined;
    const diagnostics = elementDiagnostics?.get(connection.id) ?? [];
    const summary = summarizeDiagnostics(diagnostics);
    return {
      id: connection.id,
      type: connection.type === "call" || connection.type === "request" ? "call" : undefined,
      source: connection.from,
      target: connection.to,
      sourceHandle: catalog.types.find((type) => type.id === model.blocks[connection.from]?.type)?.ports.find((port) => port.direction === "OUT")?.id,
      targetHandle: catalog.types.find((type) => type.id === model.blocks[connection.to]?.type)?.ports.find((port) => port.direction === "IN")?.id,
      data: {
        amplification, windowed: results?.window !== undefined, connection, catalog, diagnostics, overridden: overridden(connection.id), parametersEditable, disabled,
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
    if (!editable) return;
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

  return (
    <>
    <ReactFlow
      aria-label={t("editor.canvas.label")}
      ariaLabelConfig={ariaLabelConfig}
      proOptions={{ hideAttribution: true }}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, minZoom: 0.05 }}
      minZoom={0.05}
      snapToGrid
      snapGrid={[20, 20]}
      nodesDraggable={editable}
      nodesConnectable={editable}
      elementsSelectable={!disabled}
      deleteKeyCode={null}
      onNodesChange={onNodesChange}
      onEdgesChange={selectionChanges}
      onNodeClick={(event, node) => select(event, node.id)}
      onEdgeClick={(event, edge) => select(event, edge.id)}
      onPaneClick={() => { if (!disabled) onSelect([]); }}
      onDragOver={(event) => {
        if (!editable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!editable) return;
        event.preventDefault();
        const type = event.dataTransfer.getData("application/resilience-lab-block");
        const point = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
        onCommand(addBlock(catalog, type, point));
      }}
      onConnect={({ source, target, sourceHandle, targetHandle }) => {
        if (!editable) return;
        const rule = connectionRule(catalog, model, source, target, sourceHandle, targetHandle);
        setNotice(rule.error);
        if (rule.type !== null) onCommand(addConnection(catalog, source, target, sourceHandle, targetHandle));
      }}
      onConnectEnd={(_, connection) => {
        if (connection.fromNode !== null && connection.isValid !== true) setNotice(t("editor.canvas.connectionHint"));
      }}
    >
      <Background gap={20} />
      <Panel position="bottom-right" className="react-flow__attribution">
        <a href={`https://reactflow.dev${import.meta.env.PROD ? "?utm_source=attribution" : "/attribution"}`} target="_blank" rel="noopener noreferrer"
          aria-label={t("editor.canvas.attributionLabel")}>{t("editor.canvas.attribution")}</a>
      </Panel>
      {notice === null ? null : <div className="canvas-notice" role="alert">{notice}</div>}
    </ReactFlow>
    <div className="canvas-navigation react-flow" role="group" aria-label={t("editor.canvas.navigation")}>
      <Controls showInteractive={false} orientation="horizontal" />
      <MiniMap pannable zoomable style={{ width: 120, height: 48 }} />
    </div>
    </>
  );
}
