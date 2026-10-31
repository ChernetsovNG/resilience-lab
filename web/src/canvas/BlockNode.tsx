import { FaultBadge } from "../experiment/FaultBadge";
import type { CourseFault } from "../experiment/course";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { formatOutput, outputField, outputText, outputsOf, overlayOutputs, selectedOverlayOutput } from "../results/outputs";
import type { Node, NodeProps } from "@xyflow/react";
import type { BlockInstance, Catalog, Diagnostic, TypeDescriptor } from "../api/apiTypes";
import { utilizationColor, type NodeOverlayMetric, type ServiceCanvasResults } from "../results/canvasResults";
import { DiagnosticBadge, VariantDiagnosticBadge } from "../validation/DiagnosticDisplay";
import { InlineParamEditor } from "./InlineParamEditor";
import { isObject, isOverridden, type Params } from "../workspace/params";
import { catalogParameter, formatParameterValue } from "../workspace/parameterValues";
import { HelpHint } from "../help/HelpHint";
import { BlockIcon } from "../layout/BlockIcon";
import { BlockShape } from "./BlockShape";

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
  selectedReplica?: number;
  onParam: (id: string, path: string, value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}, "block">;

const keyParameters = new Map<string, readonly [string, string][]>([
  ["service", [["handlers", "editor.canvas.handlers"], ["queue", "editor.canvas.handlersQueue"], ["processing.mean", "editor.canvas.processingMean"]]],
  ["database", [["maxConnections", "editor.canvas.connections"], ["queue", "editor.canvas.handlersQueue"], ["processing.mean", "editor.canvas.queryMean"]]],
  ["pooler", [["maxClientConnections", "editor.canvas.clientConnections"], ["poolSize", "editor.canvas.serverPool"], ["waitTimeout", "editor.canvas.waitTimeout"]]],
  ["router", [["policy", "editor.canvas.routingPolicy"]]],
]);

/** A block of the model with its key parameters; ports follow the catalog (client has an output only). */
export function BlockNode({ data, width, height }: NodeProps<BlockNodeType>) {
  const isWiringHint = (diagnostic: Diagnostic) =>
    (diagnostic.code === "TOPOLOGY_GRAPH" && (diagnostic.args?.reason === "unreachable"
      || (diagnostic.args?.reason === "request" && data.outgoingConnections === 0)))
    || (diagnostic.code === "ROUTER_INPUT" && data.incomingConnections === 0)
    || (["ROUTER_OUTPUT", "POOLER_OUTPUT"].includes(diagnostic.code) && data.outgoingConnections === 0);
  const diagnostics = data.diagnostics ?? [];
  const wiringHint = data.needsConnection || diagnostics.some(isWiringHint);
  const choice = selectedOverlayOutput(overlayOutputs(data.catalog, "BLOCK"), data.nodeMetric);
  const output = choice?.types.includes(data.block.type) ? data.result?.outputs.find(output => output.id === choice.id) : undefined;
  const worstColor = output === undefined ? undefined : data.result?.worst?.[output.id];
  const colorValue = output === undefined ? null : worstColor === undefined ? data.result?.values[output.id] : worstColor?.value;
  const maximum = output?.overlay?.scaleParameter == null ? 1 : outputField(worstColor == null ? data.result?.params : data.result?.replicaParams?.[worstColor.replica] ?? data.result?.params, output.overlay.scaleParameter);
  const interval = data.result?.windowed ? t("editor.canvas.intervalWindow") : t("editor.canvas.intervalPooled");
  const tooltip = (title: string) => data.resultsPending === undefined ? title : `${title} ${t("editor.symbols.separator")} ${data.resultsPending}`;
  const editorProps = { catalog: data.catalog, elementId: data.id, elementType: data.block.type, params: data.block.params,
    modelParams: data.modelBlock?.params, editable: data.parametersEditable, disabled: data.disabled, onValidity: data.onValidity };
  const overridden = (path: string) => isOverridden(data.overrides ?? {}, data.id, path);
  const type = data.catalog.types.find(type => type.id === data.block.type) ?? { id: data.block.type, title: data.block.type };
  const load = isObject(data.block.params.load) ? data.block.params.load : {};
  const points = Array.isArray(load.points) ? load.points : [];
  const singlePoint = points.length === 1 && isObject(points[0]);
  const parameters: readonly [string, string][] = data.block.type === "client"
    ? [...(singlePoint ? [["load.points.0.rate", "editor.canvas.intensity"] as [string, string]] : []), ["deadline", "editor.canvas.deadline"]]
    : keyParameters.get(data.block.type) ?? [];
  const commit = (path: string, value: unknown) => {
    if (path === "load.points.0.rate") {
      data.onParam(data.id, "load", { ...load, points: [{ ...points[0] as Params, rate: value }] });
    } else data.onParam(data.id, path, value);
  };
  const outputs = outputsOf(data.catalog, data.block.type).filter(output => output.overlay != null)
    .sort((a, b) => a.overlay!.order - b.overlay!.order);
  const replicas = data.block.type === "service" ? Number(data.block.params.replicas ?? 1) : 1;
  return (
    <BlockShape id={data.id} type={data.block.type} replicas={replicas} overridden={data.overridden}
      ports={data.ports} editable={data.editable} width={width} height={height}
      fill={colorValue == null || typeof maximum !== "number" || maximum <= 0 ? undefined : utilizationColor(colorValue / maximum)}>
      <strong className="block-node-header">
        <span className="block-type-icon" role="img" aria-label={type.title} title={type.title}><BlockIcon type={type} /></span>
        <span className="block-node-name" title={data.id}>{data.id} {data.overridden ? <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span> : null}</span>
        {replicas > 1 ? <span className="block-replica-count" aria-label={t("editor.replicas.count", { count: formatNumber(replicas) })}>
          {t("editor.canvas.replicas", { count: formatNumber(replicas) })}</span> : null}
      </strong>
      {data.selectedReplica === undefined ? null : <span className="block-selected-replica" role="status">
        {t("results.groups.selectedReplica", { number: formatNumber(data.selectedReplica) })}</span>}
      <FaultBadge faults={data.faults} onOpen={data.onFault} disabled={data.disabled} />
      <DiagnosticBadge diagnostics={diagnostics.filter(diagnostic => !isWiringHint(diagnostic))} />
      {wiringHint ? <span className="block-wiring-hint" role="status">{t("editor.canvas.connectBlock")}</span> : null}
      <VariantDiagnosticBadge diagnostics={data.variantDiagnostics} onOpen={data.onProblems} disabled={data.disabled} />
      {data.result?.firstSaturation == null ? null : <span className="saturation-badge" role="img" aria-label={t("editor.canvas.firstSaturatedNode")}
        title={data.result.firstSaturation}>{t("editor.symbols.saturation")}</span>}
      {parameters.length > 0 ? (
        <span className="block-summary">
          {data.block.type === "client" && !singlePoint ? <span className="block-param">
            {t("editor.canvas.loadProfile")}
            <HelpHint label={type.title}>{catalogParameter(data.catalog, data.block.type, data.block.params, "load")?.descriptor.description}</HelpHint>
          </span> : null}
          {parameters.map(([path, label]) => {
            const parameter = catalogParameter(data.catalog, data.block.type, data.block.params, path);
            return parameter === undefined ? null : <span className="block-param" key={path}>
              {data.block.type === "router" ? null : t(label)}
              <InlineParamEditor {...editorProps} path={path} overridden={overridden(path)} onCommit={value => commit(path, value)} />
              {data.block.type === "service" ? null : <HelpHint label={parameter.title}>
                {data.block.type === "router" ? <><strong>{formatParameterValue(parameter.value, parameter.descriptor)}</strong><p>{parameter.descriptor.description}</p></>
                  : parameter.descriptor.description}
              </HelpHint>}
            </span>;
          })}
        </span>
      ) : null}
      {outputs.length === 0 ? null : <div className={`block-results${data.resultsPending === undefined ? "" : " canvas-metrics--pending"}${data.result === undefined || data.resultsEmpty ? " canvas-metrics--empty" : ""}`}
        aria-busy={data.resultsPending === undefined ? undefined : true} aria-hidden={data.result === undefined || data.resultsEmpty || undefined}
        data-testid={data.result === undefined ? undefined : `canvas-results-${data.id}`}>
        {outputs.map(output => {
          const worst = data.result?.worst?.[output.id];
          const text = outputText(output.overlay!.label, { value: formatOutput(output, data.result?.values[output.id]) });
          const worstArgs = worst == null ? undefined : { number: formatNumber(worst.replica), value: formatOutput(output, worst.value) };
          const fullText = text + (worstArgs === undefined ? "" : t("results.groups.worst", worstArgs));
          const description = tooltip(outputText(output.overlay!.description, { interval }));
          return <span key={output.id} title={`${fullText} ${t("editor.symbols.separator")} ${description}`}>
            <span className="block-result-text">{text}{worstArgs === undefined ? "" : t("results.groups.worstCompact", worstArgs)}</span>
            <HelpHint label={output.overlay!.title}>
              <strong>{output.overlay!.title}</strong><p>{fullText}</p><p>{description}</p>
            </HelpHint>
          </span>;
        })}
      </div>}
    </BlockShape>
  );
}
