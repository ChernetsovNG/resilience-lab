import { t } from "../i18n";
import { formatNumber, formatPercent } from "../i18n/format";
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
  if (block.type === "client") return t("editor.canvas.clientSummary", { rate: String(params.rate ?? t("editor.canvas.rateRequired")), deadline: String(params.deadline ?? t("editor.canvas.deadlineRequired")) });
  return block.type;
}

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  const interval = data.result?.windowed ? t("editor.canvas.intervalWindow") : t("editor.canvas.intervalPooled");
  const editorProps = { catalog: data.catalog, elementId: data.id, elementType: data.block.type, params: data.block.params,
    editable: data.parametersEditable, disabled: data.disabled, onValidity: data.onValidity };
  return (
    <div className={`block-node block-node--${data.block.type}`} data-testid="block-node"
      style={data.result?.utilization == null ? undefined : { backgroundColor: utilizationColor(data.result.utilization) }}>
      {data.ports.map((port) => (
        <Handle key={port.id} id={port.id} type={port.direction === "OUT" ? "source" : "target"}
          position={port.direction === "OUT" ? Position.Right : Position.Left} isConnectable={data.editable} />
      ))}
      <strong>{data.id} {data.overridden ? <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span> : null}</strong>
      <DiagnosticBadge diagnostics={data.diagnostics ?? []} />
      {data.result?.firstSaturation == null ? null : <span className="saturation-badge" role="img" aria-label={t("editor.canvas.firstSaturatedNode")}
        title={data.result.firstSaturation}>{t("editor.symbols.saturation")}</span>}
      {data.block.type === "service" ? (
        <span className="block-summary">
          <InlineParamEditor {...editorProps} path="handlers" onCommit={(value) => data.onParam(data.id, "handlers", value)} />
          <span>{t("editor.canvas.handlersQueue")}</span>
          <InlineParamEditor {...editorProps} path="queue" onCommit={(value) => data.onParam(data.id, "queue", value)} />
          <span>{t("editor.canvas.processingMean")}</span>
          <InlineParamEditor {...editorProps} path="processing.mean" onCommit={(value) => data.onParam(data.id, "processing.mean", value)} />
        </span>
      ) : <span>{summaryOf(data.block)}</span>}
      {data.result === undefined ? null : <div className="block-results" data-testid={`canvas-results-${data.id}`}>
        <span title={t("editor.canvas.utilizationTitle", { interval })}>
          {t("editor.canvas.utilization", { value: formatPercent(data.result.utilization) })}
        </span>
        <span title={t("editor.canvas.meanQueueTitle", { interval })}>
          {t("editor.canvas.meanQueue", { value: formatNumber(data.result.meanQueue) })}
        </span>
        <span title={t("editor.canvas.queueRejectionsTitle", { interval })}>
          {t("editor.canvas.queueRejections", { value: formatPercent(data.result.queueRejectionRate) })}
        </span>
      </div>}
    </div>
  );
}
