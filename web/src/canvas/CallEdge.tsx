import { t } from "../i18n";
import { formatMultiplier, formatNumber } from "../i18n/format";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";
import type { Catalog, ConnectionInstance, Diagnostic } from "../api/apiTypes";
import { summarizeDiagnostics } from "../validation/diagnostics";
import { InlineParamEditor } from "./InlineParamEditor";

export type CallEdgeType = Edge<{
  connection: ConnectionInstance;
  catalog: Catalog;
  overridden: boolean;
  diagnostics: readonly Diagnostic[];
  parametersEditable: boolean;
  disabled: boolean;
  amplification?: number | null;
  windowed?: boolean;
  onParam: (id: string, path: string, value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}, "call">;

/** A call edge with HTML labels because SVG text cannot contain parameter inputs. */
export function CallEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<CallEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { connection, catalog, overridden, diagnostics, parametersEditable, disabled, onParam, onValidity, amplification, windowed } = data!;
  const summary = summarizeDiagnostics(diagnostics);
  const editorProps = { catalog, elementId: connection.id, elementType: connection.type, params: connection.params,
    editable: parametersEditable, disabled, onValidity };
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {connection.type === "call" || amplification !== undefined ? <EdgeLabelRenderer>
        <div
          className={`canvas-edge-label nodrag nopan${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}
          data-testid={`canvas-edge-label-${connection.id}`}
          style={{ pointerEvents: "all", transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
        >
          {connection.type === "call" ? <div className="canvas-edge-parameters">
            <InlineParamEditor {...editorProps} path="timeout" onCommit={(value) => onParam(connection.id, "timeout", value)} />
            <span>{t("editor.symbols.separator")}</span>
            <InlineParamEditor {...editorProps} path="attempts" onCommit={(value) => onParam(connection.id, "attempts", value)} />
            <span>{t("editor.symbols.multiplier")}</span>
            {summary === null ? null : <span>{t("editor.diagnostics.badge", { symbol: summary.severity === "ERROR" ? t("editor.symbols.error") : t("editor.symbols.warning"), count: formatNumber(summary.count) })}</span>}
            {overridden ? <span role="img" aria-label={t("editor.canvas.overriddenParameters")}>{t("editor.symbols.overridden")}</span> : null}
          </div> : null}
          {amplification === undefined ? null : <span className="canvas-edge-results"
            title={windowed ? t("editor.canvas.amplificationWindowTitle")
              : t("editor.canvas.amplificationPooledTitle")}>
            {t("editor.canvas.amplification", { value: formatMultiplier(amplification) })}
          </span>}
        </div>
      </EdgeLabelRenderer> : null}
    </>
  );
}
