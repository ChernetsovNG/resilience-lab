import { FaultBadge } from "../experiment/FaultBadge";
import type { CourseFault } from "../experiment/course";
import { t } from "../i18n";
import { formatOutput, outputField, outputText, outputsOf, overlayOutputs, selectedOverlayOutput } from "../results/outputs";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BlockInstance, Catalog, Diagnostic, TypeDescriptor } from "../api/apiTypes";
import { utilizationColor, type NodeOverlayMetric, type ServiceCanvasResults } from "../results/canvasResults";
import { DiagnosticBadge, VariantDiagnosticBadge } from "../validation/DiagnosticDisplay";
import { InlineParamEditor } from "./InlineParamEditor";
import { isObject, isOverridden, type Params } from "../workspace/params";

export type BlockNodeType = Node<{
  id: string;
  block: BlockInstance;
  modelBlock?: BlockInstance;
  overrides?: Params;
  catalog: Catalog;
  ports: TypeDescriptor["ports"];
  editable: boolean;
  parametersEditable: boolean;
  disabled: boolean;
  overridden?: boolean;
  diagnostics?: readonly Diagnostic[];
  needsConnection: boolean;
  incomingConnections: number;
  outgoingConnections: number;
  variantDiagnostics?: readonly Diagnostic[];
  onProblems?: () => void;
  faults?: readonly CourseFault[];
  onFault?: (index: number) => void;
  result?: ServiceCanvasResults;
  resultsPending?: string;
  resultsEmpty?: boolean;
  nodeMetric?: NodeOverlayMetric;
  onParam: (id: string, path: string, value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}, "block">;

function summaryOf(block: BlockInstance, catalog: Catalog): string {
  const params = block.params;
  if (block.type === "client") {
    const load = isObject(params.load) ? params.load : {};
    const points = Array.isArray(load.points) ? load.points : [];
    const rate = points.length === 1 && isObject(points[0])
      ? String(points[0].rate) : t("editor.canvas.loadProfile");
    return t("editor.canvas.clientSummary", { rate, deadline: String(params.deadline ?? t("editor.canvas.deadlineRequired")) });
  }
  return catalog.types.find(type => type.id === block.type)?.title ?? block.type;
}

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  const isWiringHint = (diagnostic: Diagnostic) =>
    (diagnostic.code === "TOPOLOGY_GRAPH" && (diagnostic.args?.reason === "unreachable"
      || (diagnostic.args?.reason === "request" && data.outgoingConnections === 0)))
    || (diagnostic.code === "ROUTER_INPUT" && data.incomingConnections === 0)
    || (["ROUTER_OUTPUT", "POOLER_OUTPUT"].includes(diagnostic.code) && data.outgoingConnections === 0);
  const diagnostics = data.diagnostics ?? [];
  const wiringHint = data.needsConnection || diagnostics.some(isWiringHint);
  const choice = selectedOverlayOutput(overlayOutputs(data.catalog, "BLOCK"), data.nodeMetric);
  const output = choice?.types.includes(data.block.type) ? data.result?.outputs.find(output => output.id === choice.id) : undefined;
  const colorValue = output === undefined ? null : data.result?.values[output.id];
  const maximum = output?.overlay?.scaleParameter == null ? 1 : outputField(data.result?.params, output.overlay.scaleParameter);
  const interval = data.result?.windowed ? t("editor.canvas.intervalWindow") : t("editor.canvas.intervalPooled");
  const tooltip = (title: string) => data.resultsPending === undefined ? title : `${title} ${t("editor.symbols.separator")} ${data.resultsPending}`;
  const editorProps = { catalog: data.catalog, elementId: data.id, elementType: data.block.type, params: data.block.params,
    modelParams: data.modelBlock?.params, editable: data.parametersEditable, disabled: data.disabled, onValidity: data.onValidity };
  const overridden = (path: string) => isOverridden(data.overrides ?? {}, data.id, path);
  const database = data.block.type === "database";
  const outputs = outputsOf(data.catalog, data.block.type).filter(output => output.overlay != null)
    .sort((a, b) => a.overlay!.order - b.overlay!.order);
  return (
    <div className={`block-node block-node--${data.block.type}${data.overridden ? " block-node--overridden" : ""}`} data-testid="block-node"
      style={colorValue == null || typeof maximum !== "number" || maximum <= 0 ? undefined : { backgroundColor: utilizationColor(colorValue / maximum) }}>
      {data.ports.map((port) => (
        <Handle key={port.id} id={port.id} type={port.direction === "OUT" ? "source" : "target"}
          position={port.direction === "OUT" ? Position.Right : Position.Left} isConnectable={data.editable} />
      ))}
      <strong>{data.id} {data.overridden ? <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span> : null}</strong>
      <FaultBadge faults={data.faults} onOpen={data.onFault} disabled={data.disabled} />
      <DiagnosticBadge diagnostics={diagnostics.filter(diagnostic => !isWiringHint(diagnostic))} />
      {wiringHint ? <span className="block-wiring-hint" role="status">{t("editor.canvas.connectBlock")}</span> : null}
      <VariantDiagnosticBadge diagnostics={data.variantDiagnostics} onOpen={data.onProblems} disabled={data.disabled} />
      {data.result?.firstSaturation == null ? null : <span className="saturation-badge" role="img" aria-label={t("editor.canvas.firstSaturatedNode")}
        title={data.result.firstSaturation}>{t("editor.symbols.saturation")}</span>}
      {data.block.type === "service" ? (
        <span className="block-summary">
          <span>{t("editor.canvas.handlers")}
            <InlineParamEditor {...editorProps} path="handlers" overridden={overridden("handlers")} onCommit={(value) => data.onParam(data.id, "handlers", value)} />
          </span>
          <span>{t("editor.canvas.handlersQueue")}
            <InlineParamEditor {...editorProps} path="queue" overridden={overridden("queue")} onCommit={(value) => data.onParam(data.id, "queue", value)} />
          </span>
          <span>{t("editor.canvas.processingMean")}
            <InlineParamEditor {...editorProps} path="processing.mean" overridden={overridden("processing.mean")} onCommit={(value) => data.onParam(data.id, "processing.mean", value)} />
          </span>
        </span>
      ) : database ? <span>{summaryOf(data.block, data.catalog)}{t("editor.symbols.separator")}{t("editor.canvas.connections")}
        <InlineParamEditor {...editorProps} path="maxConnections" overridden={overridden("maxConnections")}
          onCommit={(value) => data.onParam(data.id, "maxConnections", value)} />
      </span> : <span>{data.overridden && data.modelBlock !== undefined && data.block.type === "client"
        ? <del className="inline-param-model">{summaryOf(data.modelBlock, data.catalog)}</del> : null}{summaryOf(data.block, data.catalog)}</span>}
      {outputs.length === 0 ? null : <div className={`block-results${data.resultsPending === undefined ? "" : " canvas-metrics--pending"}${data.result === undefined || data.resultsEmpty ? " canvas-metrics--empty" : ""}`}
        aria-busy={data.resultsPending === undefined ? undefined : true} aria-hidden={data.result === undefined || data.resultsEmpty || undefined}
        data-testid={data.result === undefined ? undefined : `canvas-results-${data.id}`}>
        {outputs.map(output => {
          const text = outputText(output.overlay!.label, { value: formatOutput(output, data.result?.values[output.id]) });
          return <span key={output.id}
            title={tooltip(`${text} ${t("editor.symbols.separator")} ${outputText(output.overlay!.description, { interval })}`)}>
            {text}
          </span>;
        })}
      </div>}
    </div>
  );
}
