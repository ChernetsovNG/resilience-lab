import type { ApiProblem, JobView, RunSummary } from "../api/apiTypes";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

export interface ResultsPanelProps {
  job: JobView | null;
  summary: RunSummary | null;
  problem: ApiProblem | null;
}

function progressOf(job: JobView): string {
  return `${job.status} · ${job.completedTasks}/${job.totalTasks === 0 ? "?" : job.totalTasks} tasks`;
}

/** Results panel below the screen (product vision §5.5); the slice has the Summary tab only. */
export function ResultsPanel({ job, summary, problem }: ResultsPanelProps) {
  return (
    <section className="results-panel" aria-label="Results">
      <div role="tablist" aria-label="Result views">
        <button type="button" role="tab" aria-selected="true">
          Summary
        </button>
      </div>
      <div className="results-body">
        {problem !== null ? (
          <ProblemList problem={problem} />
        ) : summary !== null ? (
          <SummaryTable summary={summary} />
        ) : (
          <p className="results-empty">{job === null ? "Run the experiment to see results." : progressOf(job)}</p>
        )}
      </div>
    </section>
  );
}
