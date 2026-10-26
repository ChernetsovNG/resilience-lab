import type { ValidationIssue } from "../api/types";

interface TopologyIssuesProps {
  issues: ValidationIssue[];
}

export function TopologyIssues({ issues }: TopologyIssuesProps) {
  return (
    <section className="topology-issues" aria-labelledby="topology-issues-title">
      <h3 id="topology-issues-title">Topology checks</h3>
      <div id="topology-issues" role="status" aria-live="polite" aria-atomic="true">
        {issues.length === 0 ? (
          <p>Both chains are structurally valid.</p>
        ) : (
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <strong>{issue.path}:</strong> {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
