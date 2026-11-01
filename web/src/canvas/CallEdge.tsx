import { HelpHint } from "../help/HelpHint";
import { FaultBadge } from "../experiment/FaultBadge";
import type { CourseFault } from "../experiment/course";
import { t } from "../i18n";
import { elementLabel } from "../presentation/labels";
import { observeResize } from "../layout/observeResize";
import { formatOutput, outputText, overlayOutputs, selectedOverlayOutput } from "../results/outputs";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";
import type { Catalog, ConnectionInstance, Diagnostic } from "../api/apiTypes";
import { summarizeDiagnostics } from "../validation/diagnostics";
import type { ConnectionCanvasResults, ConnectionOverlayMetric } from "../results/canvasResults";
import { InlineParamEditor } from "./InlineParamEditor";
import { DiagnosticBadge, VariantDiagnosticBadge } from "../validation/DiagnosticDisplay";
import { isObject, isOverridden, ownEntry, type Params } from "../workspace/params";
import { catalogOption } from "../i18n/catalog";
import { createContext, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Rect } from "@xyflow/react";
import { diagramBounds, layoutEdges, type EdgeGeometry, type EdgeMeasurement } from "./edgeGeometry";

const EdgeLayoutContext = createContext<{ geometries: Map<string, EdgeGeometry>;
  onMeasure: (id: string, measurement: EdgeMeasurement) => void } | null>(null);

/** Edge measurements update edges without sending measured nodes through another React Flow update. */
export function EdgeLayoutProvider({ nodes, connections, onBounds, children }: {
  nodes: ReadonlyMap<string, Rect>; connections: readonly ConnectionInstance[]; onBounds?: (bounds: Rect | null) => void; children: ReactNode;
}) {
  const [measurements, setMeasurements] = useState<Record<string, EdgeMeasurement>>({});
  const onMeasure = useCallback((id: string, measurement: EdgeMeasurement) => {
    setMeasurements(current => {
      const previous = ownEntry(current, id);
      return previous !== undefined && Object.entries(measurement).every(([key, value]) => previous[key as keyof EdgeMeasurement] === value)
        ? current : { ...current, [id]: measurement };
    });
  }, []);
  const geometries = useMemo(() => layoutEdges(connections.flatMap(connection => {
    const measurement = ownEntry(measurements, connection.id);
    return measurement === undefined ? [] : [{ ...measurement, id: connection.id, from: connection.from, to: connection.to }];
  }), nodes), [connections, measurements, nodes]);
  const bounds = useMemo(() => diagramBounds([
    ...[...nodes.values()].filter(node => node.width > 0 && node.height > 0),
    ...[...geometries.values()].map(geometry => geometry.bounds),
  ]), [nodes, geometries]);
  useEffect(() => { onBounds?.(bounds); }, [onBounds, bounds]);
  return <EdgeLayoutContext value={{ geometries, onMeasure }}>{children}</EdgeLayoutContext>;
}

export type CallEdgeType = Edge<{
  connection: ConnectionInstance;
  modelParams?: Params;
  overrides?: Params;
  catalog: Catalog;
  overridden: boolean;
  diagnostics: readonly Diagnostic[];
  variantDiagnostics?: readonly Diagnostic[];
  onProblems?: () => void;
  faults?: readonly CourseFault[];
  onFault?: (index: number) => void;
  parametersEditable: boolean;
  disabled: boolean;
  result?: ConnectionCanvasResults;
  resultsPending?: string;
  resultsEmpty?: boolean;
  connectionMetric?: ConnectionOverlayMetric;
  onSelect?: (multiple: boolean) => void;
  windowed?: boolean;
  targetGroup?: boolean;
  onParam: (id: string, path: string, value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}, "call">;

/** A call edge with HTML labels because SVG text cannot contain parameter inputs. */
export function CallEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<CallEdgeType>) {
  const layout = useContext(EdgeLayoutContext);
  const geometry = layout?.geometries.get(id);
  const [initialPath, initialX, initialY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const path = geometry?.path ?? initialPath;
  const { x: labelX, y: labelY } = geometry?.label ?? { x: initialX, y: initialY };
  const { connection, catalog, overridden, diagnostics, variantDiagnostics = [], onProblems, parametersEditable, disabled, onParam, onValidity, windowed, result, resultsPending, resultsEmpty, connectionMetric = "amplification", onSelect } = data!;
  const connectionLabel = elementLabel(connection.id, { connections: [connection] });
  const summary = summarizeDiagnostics(diagnostics);
  const editorProps = { catalog, elementId: connection.id, elementType: connection.type, params: connection.params,
    modelParams: data?.modelParams, editable: parametersEditable, disabled, onValidity };
  const output = selectedOverlayOutput(overlayOutputs(catalog, "CONNECTION"), connectionMetric);
  const metricValue = output?.types.includes(connection.type) ? result?.values[output.id] ?? null : null;
  const metricText = output === undefined ? "" : outputText(output.overlay!.label, { value: formatOutput(output, metricValue) });
  const metricTitle = output?.overlay == null ? "" : windowed ? output.overlay.windowDescription ?? output.overlay.description : output.overlay.description;
  const tooltip = resultsPending === undefined ? metricTitle : `${metricTitle} ${t("editor.symbols.separator")} ${resultsPending}`;
  const labelled = Boolean(connection.description) || connection.type === "call" || overridden || (data?.faults?.length ?? 0) > 0 || result !== undefined || diagnostics.length > 0 || variantDiagnostics.length > 0;
  const label = useRef<HTMLDivElement>(null);
  const onMeasure = layout?.onMeasure;
  const measure = useEffectEvent(() => {
    const element = label.current;
    onMeasure?.(id, { sourceX, sourceY, targetX, targetY,
      width: element?.offsetWidth ?? 0, height: element?.offsetHeight ?? 0 });
  });
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(frame);
  }, [id, sourceX, sourceY, targetX, targetY, labelled, onMeasure]);
  useLayoutEffect(() => {
    const element = label.current;
    if (element !== null) return observeResize([element], () => measure());
  }, [labelled]);
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={28}
        style={selected ? { stroke: "#2563eb", strokeWidth: 2.5 } : undefined} />
      {labelled ? <EdgeLabelRenderer>
        <div ref={label}
          className={`canvas-edge-label nodrag nopan${selected ? " canvas-edge-label--selected" : ""}${overridden ? " canvas-edge-label--overridden" : ""}${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}
          data-testid={`canvas-edge-label-${connection.id}`}
          role="button" tabIndex={0} aria-label={connectionLabel} aria-pressed={selected}
          onClick={event => { event.stopPropagation(); onSelect?.(event.ctrlKey || event.metaKey || event.shiftKey); }}
          onKeyDown={event => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault(); event.stopPropagation(); onSelect?.(event.ctrlKey || event.metaKey || event.shiftKey);
            }
          }}
          style={{ pointerEvents: "all", transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
        >
          {connection.description ? <div className="canvas-edge-name">{connectionLabel}
            <HelpHint label={connectionLabel}><span className="annotation-text">{connection.description}</span></HelpHint>
          </div> : null}
          {connection.type === "call" ? <div className="canvas-edge-parameters">
            <InlineParamEditor {...editorProps} path="timeout" overridden={isOverridden(data?.overrides ?? {}, connection.id, "timeout")} onCommit={(value) => onParam(connection.id, "timeout", value)} />
            <span>{t("editor.symbols.separator")}</span>
            <span>{t("editor.symbols.multiplier")}</span>
            <InlineParamEditor {...editorProps} path="attempts" overridden={isOverridden(data?.overrides ?? {}, connection.id, "attempts")} onCommit={(value) => onParam(connection.id, "attempts", value)} />
            {isObject(connection.params.pool) ? <span>{t("editor.symbols.separator")}{t("editor.canvas.pool")} <InlineParamEditor {...editorProps}
              path="pool.size" overridden={isOverridden(data?.overrides ?? {}, connection.id, "pool.size")}
              onCommit={value => onParam(connection.id, "pool.size", value)} /></span> : null}
            {data?.targetGroup && connection.params.balancing != null ? <span>
              {t("editor.symbols.separator")}{catalogOption(String(connection.params.balancing))}
            </span> : null}
            {overridden ? <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span> : null}
          </div> : overridden ? <div className="canvas-edge-parameters">
            {catalog.types.find(type => type.id === connection.type)?.params
              .filter(param => param.kind !== "OBJECT" && param.kind !== "ARRAY" && isOverridden(data?.overrides ?? {}, connection.id, param.name))
              .map(param => <span key={param.name}>{param.title}{" "}
                <InlineParamEditor {...editorProps} path={param.name} overridden onCommit={value => onParam(connection.id, param.name, value)} />
              </span>)}
            <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span>
          </div> : null}
          <FaultBadge faults={data?.faults} onOpen={data?.onFault} disabled={disabled} />
          <DiagnosticBadge diagnostics={diagnostics} />
          <VariantDiagnosticBadge diagnostics={variantDiagnostics} onOpen={onProblems} disabled={disabled} />
          {result === undefined ? null : <span className={`canvas-edge-results${resultsPending === undefined ? "" : " canvas-metrics--pending"}${resultsEmpty ? " canvas-metrics--empty" : ""}`}
            aria-busy={resultsPending === undefined ? undefined : true} aria-hidden={resultsEmpty || undefined}
            title={tooltip}>
            {metricText}
          </span>}
        </div>
      </EdgeLabelRenderer> : null}
    </>
  );
}
