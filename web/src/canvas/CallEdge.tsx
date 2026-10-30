import { FaultBadge } from "../experiment/FaultBadge";
import type { CourseFault } from "../experiment/course";
import { t } from "../i18n";
import { formatOutput, outputText, overlayOutputs, selectedOverlayOutput } from "../results/outputs";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";
import type { Catalog, ConnectionInstance, Diagnostic } from "../api/apiTypes";
import { summarizeDiagnostics } from "../validation/diagnostics";
import type { ConnectionCanvasResults, ConnectionOverlayMetric } from "../results/canvasResults";
import { InlineParamEditor } from "./InlineParamEditor";
import { DiagnosticBadge, VariantDiagnosticBadge } from "../validation/DiagnosticDisplay";

export type CallEdgeType = Edge<{
  connection: ConnectionInstance;
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
  labelY?: number;
  connectionMetric?: ConnectionOverlayMetric;
  onSelect?: (multiple: boolean) => void;
  windowed?: boolean;
  onParam: (id: string, path: string, value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}, "call">;

/** A call edge with HTML labels because SVG text cannot contain parameter inputs. */
export function CallEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<CallEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { connection, catalog, overridden, diagnostics, variantDiagnostics = [], onProblems, parametersEditable, disabled, onParam, onValidity, windowed, result, resultsPending, resultsEmpty, connectionMetric = "amplification", onSelect, labelY: badgeY } = data!;
  const summary = summarizeDiagnostics(diagnostics);
  const editorProps = { catalog, elementId: connection.id, elementType: connection.type, params: connection.params,
    editable: parametersEditable, disabled, onValidity };
  const output = selectedOverlayOutput(overlayOutputs(catalog, "CONNECTION"), connectionMetric);
  const metricValue = output?.types.includes(connection.type) ? result?.values[output.id] ?? null : null;
  const metricText = output === undefined ? "" : outputText(output.overlay!.label, { value: formatOutput(output, metricValue) });
  const metricTitle = output?.overlay == null ? "" : windowed ? output.overlay.windowDescription ?? output.overlay.description : output.overlay.description;
  const tooltip = resultsPending === undefined ? metricTitle : `${metricTitle} ${t("editor.symbols.separator")} ${resultsPending}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={28}
        style={selected ? { stroke: "#2563eb", strokeWidth: 2.5 } : undefined} />
      {connection.type === "call" || (data?.faults?.length ?? 0) > 0 || result !== undefined || diagnostics.length > 0 || variantDiagnostics.length > 0 ? <EdgeLabelRenderer>
        <div
          className={`canvas-edge-label nodrag nopan${selected ? " canvas-edge-label--selected" : ""}${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}
          data-testid={`canvas-edge-label-${connection.id}`}
          role="button" tabIndex={0} aria-label={connection.id} aria-pressed={selected}
          onClick={event => { event.stopPropagation(); onSelect?.(event.ctrlKey || event.metaKey || event.shiftKey); }}
          onKeyDown={event => {
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault(); event.stopPropagation(); onSelect?.(event.ctrlKey || event.metaKey || event.shiftKey);
            }
          }}
          style={{ pointerEvents: "all", transform: `translate(-50%, -100%) translate(${labelX}px,${badgeY ?? labelY - 36}px)` }}
        >
          {connection.type === "call" ? <div className="canvas-edge-parameters">
            <InlineParamEditor {...editorProps} path="timeout" onCommit={(value) => onParam(connection.id, "timeout", value)} />
            <span>{t("editor.symbols.separator")}</span>
            <InlineParamEditor {...editorProps} path="attempts" onCommit={(value) => onParam(connection.id, "attempts", value)} />
            <span>{t("editor.symbols.multiplier")}</span>
            {overridden ? <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span> : null}
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
