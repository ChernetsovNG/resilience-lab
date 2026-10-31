import { t } from "../i18n";
import type { ApiProblem } from "../api/apiTypes";
import { locationOf } from "../validation/diagnostics";
import { useContext } from "react";
import { DiagnosticLabelContext } from "../presentation/diagnosticContext";
import { diagnosticMessage, type DiagnosticPresentationContext } from "../presentation/labels";

/** An API problem with its diagnostics (stage 1 design §4.1). */
export function ProblemList({ problem, context }: { problem: ApiProblem; context?: DiagnosticPresentationContext }) {
  const inherited = useContext(DiagnosticLabelContext);
  const display = context ?? inherited;
  return (
    <div className="problem-list" role="alert">
      <p>{diagnosticMessage(problem, display.catalog, display.model, display)}</p>
      {problem.diagnostics.length === 0 ? null : (
        <ul>
          {problem.diagnostics.map((diagnostic, index) => (
            <li key={index}>
              <span className="diagnostic-message">{diagnosticMessage(diagnostic, display.catalog, display.model, display)}</span>
              <span className="diagnostic-details">{t("results.problems.details", { code: diagnostic.code, document: locationOf(diagnostic) })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
