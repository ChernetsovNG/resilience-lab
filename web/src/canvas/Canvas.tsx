import { useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { Edge, NodeChange } from "@xyflow/react";
import type { Catalog, Diagnostic, LayoutFile, ModelFile } from "../api/apiTypes";
import type { CanvasResults } from "../results/canvasResults";
import { summarizeDiagnostics } from "../validation/diagnostics";
import { ownEntry } from "../workspace/params";
import type { EditorCommand } from "../workspace/editor";
import { addBlock, addConnection, connectionRule, moveBlocks, positionOf } from "../workspace/structure";
import { BlockNode } from "./BlockNode";
import type { BlockNodeType } from "./BlockNode";
import { CallEdge } from "./CallEdge";
import "@xyflow/react/dist/style.css";

const nodeTypes = { block: BlockNode };
const edgeTypes = { call: CallEdge };

export interface CanvasProps {
  /** The model as the active variant page sees it. */
  model: ModelFile;
  overrides?: Record<string, unknown>;
  results?: CanvasResults | null;
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
}

/** The model on a React Flow canvas (ADR 0004); documents and one-command gestures own all edits. */
export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><ModelCanvas {...props} /></ReactFlowProvider>;
}

function ModelCanvas({ model, layout, catalog, selected, onSelect, editable = false, parametersEditable = false,
  disabled = false, onCommand, onParam, onValidity, elementDiagnostics, overrides = {}, results = null }: CanvasProps) {
  const overridden = (id: string) => Object.keys(overrides).some((path) => path.startsWith(`${id}.`));
  const { screenToFlowPosition } = useReactFlow();
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [moving, setMoving] = useState<LayoutFile["positions"]>({});
  const [notice, setNotice] = useState<string | null>(null);
  const nodes: BlockNodeType[] = Object.entries(model.blocks).map(([id, block]) => ({
    id,
    type: "block",
    position: ownEntry(moving, id) ?? positionOf(model, layout, id),
    measured: ownEntry(sizes, id),
    data: {
      result: block.type === "service" ? results?.services.get(id) : undefined,
      id, block, catalog, overridden: overridden(id), diagnostics: elementDiagnostics?.get(id),
      ports: catalog.types.find((type) => type.id === block.type)?.ports ?? [], editable, parametersEditable, disabled,
      onParam: (elementId, path, value) => onParam?.(elementId, path, value),
      onValidity: (key, valid) => onValidity?.(key, valid),
    },
    selected: selected.includes(id),
    ariaLabel: id,
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
        amplification, connection, catalog, diagnostics, overridden: overridden(connection.id), parametersEditable, disabled,
        onParam: (elementId: string, path: string, value: unknown) => onParam?.(elementId, path, value),
        onValidity: (key: string, valid: boolean) => onValidity?.(key, valid),
      },
      className: summary === null ? undefined : `diagnostic--${summary.severity.toLowerCase()}`,
      selected: selected.includes(connection.id),
      ariaLabel: connection.id,
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
    <ReactFlow
      aria-label="Model canvas"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
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
        if (connection.fromNode !== null && connection.isValid !== true) setNotice("Connect an output port to an input port allowed by the catalog.");
      }}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable style={{ width: 120, height: 70 }} />
      {notice === null ? null : <div className="canvas-notice" role="alert">{notice}</div>}
    </ReactFlow>
  );
}
