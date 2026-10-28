import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BlockInstance, Diagnostic, TypeDescriptor } from "../api/apiTypes";
import { DiagnosticBadge } from "../validation/DiagnosticDisplay";

export type BlockNodeType = Node<{ id: string; block: BlockInstance; ports: TypeDescriptor["ports"]; editable: boolean; overridden?: boolean; diagnostics?: readonly Diagnostic[] }, "block">;

function summaryOf(block: BlockInstance): string {
  const params = block.params;
  if (block.type === "client") return `${String(params.rate ?? "Rate required")} · deadline ${String(params.deadline ?? "required")}`;
  if (block.type === "service") return `${String(params.handlers ?? "Required")} handlers · queue ${String(params.queue ?? 0)}`;
  return block.type;
}

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  return (
    <div className={`block-node block-node--${data.block.type}`} data-testid="block-node">
      {data.ports.map((port) => (
        <Handle key={port.id} id={port.id} type={port.direction === "OUT" ? "source" : "target"}
          position={port.direction === "OUT" ? Position.Right : Position.Left} isConnectable={data.editable} />
      ))}
      <strong>{data.id} {data.overridden ? <span role="img" aria-label="Overridden parameters">◆</span> : null}</strong>
      <DiagnosticBadge diagnostics={data.diagnostics ?? []} />
      <span>{summaryOf(data.block)}</span>
    </div>
  );
}
