import { t } from "../i18n";
import { formatMultiplier, formatNumber, formatPercent, formatRate } from "../i18n/format";
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
  parametersEditable: boolean;
  disabled: boolean;
  amplification?: number | null;
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
  const { connection, catalog, overridden, diagnostics, variantDiagnostics = [], onProblems, parametersEditable, disabled, onParam, onValidity, amplification, windowed, result, resultsPending, resultsEmpty, connectionMetric = "amplification", onSelect, labelY: badgeY } = data!;
  const summary = summarizeDiagnostics(diagnostics);
  const editorProps = { catalog, elementId: connection.id, elementType: connection.type, params: connection.params,
    editable: parametersEditable, disabled, onValidity };
  const metricValue = result?.[connectionMetric] ?? null;
  const metricText = connectionMetric === "sentAttemptsPerSecond" ? formatRate(metricValue)
    : connectionMetric === "timeoutRate" ? formatPercent(metricValue)
      : connectionMetric === "meanOrphaned" ? formatNumber(metricValue) : formatMultiplier(amplification ?? null);
  const metricTitle = connectionMetric === "amplification" ? windowed ? t("editor.canvas.amplificationWindowTitle")
    : t("editor.canvas.amplificationPooledTitle") : t(`results.context.connection.metric.${connectionMetric}`);
  const tooltip = resultsPending === undefined ? metricTitle : `${metricTitle} ${t("editor.symbols.separator")} ${resultsPending}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={28}
        style={selected ? { stroke: "#2563eb", strokeWidth: 2.5 } : undefined} />
      {connection.type === "call" || amplification !== undefined || diagnostics.length > 0 || variantDiagnostics.length > 0 ? <EdgeLabelRenderer>
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
          <DiagnosticBadge diagnostics={diagnostics} />
          <VariantDiagnosticBadge diagnostics={variantDiagnostics} onOpen={onProblems} disabled={disabled} />
          {amplification === undefined ? null : <span className={`canvas-edge-results${resultsPending === undefined ? "" : " canvas-metrics--pending"}${resultsEmpty ? " canvas-metrics--empty" : ""}`}
            aria-busy={resultsPending === undefined ? undefined : true} aria-hidden={resultsEmpty || undefined}
            title={tooltip}>
            {connectionMetric === "amplification" ? t("editor.canvas.amplification", { value: metricText })
              : t("editor.canvas.connectionMetric", { metric: t(`results.context.connection.metric.${connectionMetric}`), value: metricText })}
          </span>}
        </div>
      </EdgeLabelRenderer> : null}
    </>
  );
}
