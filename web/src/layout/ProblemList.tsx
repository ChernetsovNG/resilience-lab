import { t } from "../i18n";
import type { ApiProblem } from "../api/apiTypes";
import { locationOf } from "../validation/diagnostics";

/** An API problem with its diagnostics (stage 1 design §4.1). */
export function ProblemList({ problem }: { problem: ApiProblem }) {
  return (
    <div className="problem-list" role="alert">
      <p>{problem.message}</p>
      {problem.diagnostics.length === 0 ? null : (
        <ul>
          {problem.diagnostics.map((diagnostic, index) => (
            <li key={index}>
              {t("results.problemDiagnostic", { code: diagnostic.code, location: locationOf(diagnostic), message: diagnostic.message })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
