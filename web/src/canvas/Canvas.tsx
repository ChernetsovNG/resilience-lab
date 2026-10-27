import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import type { ConnectionInstance, LayoutFile, ModelFile } from "../api/apiTypes";
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
}

function labelOf(connection: ConnectionInstance): string | undefined {
  if (connection.type !== "call") return undefined;
  return `${String(connection.params.timeout)} · ${String(connection.params.attempts ?? 1)}×`;
}

/** The model on a React Flow canvas (ADR 0004); structure is read-only in the stage 1 slice. */
export function Canvas({ model, layout, selected, onSelect }: CanvasProps) {
  const nodes: BlockNodeType[] = Object.entries(model.blocks).map(([id, block], index) => ({
    id,
    type: "block",
    position: (layout === null ? undefined : ownEntry(layout.positions, id)) ?? { x: index * 260, y: 100 },
    data: { id, block },
    selected: selected === id,
    ariaLabel: id,
  }));
  const edges: Edge[] = model.connections.map((connection) => ({
    id: connection.id,
    source: connection.from,
    target: connection.to,
    label: labelOf(connection),
    selected: selected === connection.id,
    ariaLabel: connection.id,
  }));

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
