import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BlockInstance, Diagnostic } from "../api/apiTypes";
import { DiagnosticBadge } from "../validation/DiagnosticDisplay";

export type BlockNodeType = Node<{ id: string; block: BlockInstance; diagnostics?: readonly Diagnostic[] }, "block">;

function summaryOf(block: BlockInstance): string {
  const params = block.params;
  if (block.type === "client") return `${String(params.rate)} · deadline ${String(params.deadline)}`;
  if (block.type === "service") return `${String(params.handlers)} handlers · queue ${String(params.queue ?? 0)}`;
  return block.type;
}

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  return (
    <div className={`block-node block-node--${data.block.type}`} data-testid="block-node">
      {data.block.type === "client" ? null : <Handle type="target" position={Position.Left} isConnectable={false} />}
      <strong>{data.id}</strong>
      <DiagnosticBadge diagnostics={data.diagnostics ?? []} />
      <span>{summaryOf(data.block)}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
