import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import type { ConnectionInstance, Diagnostic, LayoutFile, ModelFile } from "../api/apiTypes";
import { summarizeDiagnostics } from "../validation/diagnostics";
import { ownEntry } from "../workspace/params";
import { BlockNode } from "./BlockNode";
import type { BlockNodeType } from "./BlockNode";
import "@xyflow/react/dist/style.css";

const nodeTypes = { block: BlockNode };

export interface CanvasProps {
  /** The model as the active variant page sees it. */
  model: ModelFile;
  layout: LayoutFile | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  elementDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

function labelOf(connection: ConnectionInstance): string | undefined {
  if (connection.type !== "call") return undefined;
  return `${String(connection.params.timeout)} · ${String(connection.params.attempts ?? 1)}×`;
}

/** The model on a React Flow canvas (ADR 0004); structure is read-only in the stage 1 slice. */
export function Canvas({ model, layout, selected, onSelect, elementDiagnostics }: CanvasProps) {
  const nodes: BlockNodeType[] = Object.entries(model.blocks).map(([id, block], index) => ({
    id,
    type: "block",
    position: (layout === null ? undefined : ownEntry(layout.positions, id)) ?? { x: index * 260, y: 100 },
    data: { id, block, diagnostics: elementDiagnostics?.get(id) },
    selected: selected === id,
    ariaLabel: id,
  }));
  const edges: Edge[] = model.connections.map((connection) => {
    const summary = summarizeDiagnostics(elementDiagnostics?.get(connection.id) ?? []);
    const label = labelOf(connection);
    return {
    id: connection.id,
    source: connection.from,
    target: connection.to,
    label: summary === null ? label : [label, `${summary.severity === "ERROR" ? "!" : "⚠"} ${summary.count}`].filter(Boolean).join(" · "),
    className: summary === null ? undefined : `diagnostic--${summary.severity.toLowerCase()}`,
    selected: selected === connection.id,
    ariaLabel: connection.id,
    };
  });

  return (
    <ReactFlow
      aria-label="Model canvas"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => onSelect(edge.id)}
      onPaneClick={() => onSelect(null)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
