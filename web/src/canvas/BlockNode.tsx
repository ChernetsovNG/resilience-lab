import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BlockInstance, Catalog, Diagnostic, TypeDescriptor } from "../api/apiTypes";
import { utilizationColor, type ServiceCanvasResults } from "../results/canvasResults";
import { DiagnosticBadge } from "../validation/DiagnosticDisplay";
import { InlineParamEditor } from "./InlineParamEditor";

export type BlockNodeType = Node<{
  id: string;
  block: BlockInstance;
  catalog: Catalog;
  ports: TypeDescriptor["ports"];
  editable: boolean;
  parametersEditable: boolean;
  disabled: boolean;
  overridden?: boolean;
  diagnostics?: readonly Diagnostic[];
  result?: ServiceCanvasResults;
  onParam: (id: string, path: string, value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}, "block">;

function summaryOf(block: BlockInstance): string {
  const params = block.params;
  if (block.type === "client") return `${String(params.rate ?? "Rate required")} · deadline ${String(params.deadline ?? "required")}`;
  return block.type;
}

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  const editorProps = { catalog: data.catalog, elementId: data.id, elementType: data.block.type, params: data.block.params,
    editable: data.parametersEditable, disabled: data.disabled, onValidity: data.onValidity };
  return (
    <div className={`block-node block-node--${data.block.type}`} data-testid="block-node"
      style={data.result?.utilization == null ? undefined : { backgroundColor: utilizationColor(data.result.utilization) }}>
      {data.ports.map((port) => (
        <Handle key={port.id} id={port.id} type={port.direction === "OUT" ? "source" : "target"}
          position={port.direction === "OUT" ? Position.Right : Position.Left} isConnectable={data.editable} />
      ))}
      <strong>{data.id} {data.overridden ? <span role="img" aria-label="Overridden parameters">◆</span> : null}</strong>
      <DiagnosticBadge diagnostics={data.diagnostics ?? []} />
      {data.result?.firstSaturation == null ? null : <span className="saturation-badge" role="img" aria-label="First saturated node"
        title={data.result.firstSaturation}>★</span>}
      {data.block.type === "service" ? (
        <span className="block-summary">
          <InlineParamEditor {...editorProps} path="handlers" onCommit={(value) => data.onParam(data.id, "handlers", value)} />
          <span> handlers · queue </span>
          <InlineParamEditor {...editorProps} path="queue" onCommit={(value) => data.onParam(data.id, "queue", value)} />
          <span> · mean </span>
          <InlineParamEditor {...editorProps} path="processing.mean" onCommit={(value) => data.onParam(data.id, "processing.mean", value)} />
        </span>
      ) : <span>{summaryOf(data.block)}</span>}
      {data.result === undefined ? null : <div className="block-results" data-testid={`canvas-results-${data.id}`}>
        <span title="Busy handler time / handler capacity time, pooled across replications.">
          Utilization {data.result.utilization === null ? "n/a" : `${(data.result.utilization * 100).toFixed(1)}%`}
        </span>
        <span title="Queue length integral / measurement time, pooled across replications.">
          Mean queue {data.result.meanQueue === null ? "n/a" : data.result.meanQueue.toFixed(2)}
        </span>
        <span title="Queue rejections / offered attempts, pooled across replications.">
          Queue rejections {data.result.queueRejectionRate === null ? "n/a" : `${(data.result.queueRejectionRate * 100).toFixed(1)}%`}
        </span>
      </div>}
    </div>
  );
}
