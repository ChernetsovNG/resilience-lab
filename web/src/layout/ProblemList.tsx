import type { ApiProblem, Diagnostic } from "../api/apiTypes";

function locationOf(diagnostic: Diagnostic): string {
  return [diagnostic.document, diagnostic.pointer].filter((part) => part != null && part !== "").join("#") || "experiment";
}

/** An API problem with its diagnostics (stage 1 design §4.1). */
export function ProblemList({ problem }: { problem: ApiProblem }) {
  return (
    <div className="problem-list" role="alert">
      <p>{problem.message}</p>
      {problem.diagnostics.length === 0 ? null : (
        <ul>
          {problem.diagnostics.map((diagnostic, index) => (
            <li key={index}>
              {diagnostic.code} {locationOf(diagnostic)}: {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
