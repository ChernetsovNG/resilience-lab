import { useId, useState } from "react";
import type { ApiProblem, Catalog, Diagnostic, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { locationOf } from "../validation/diagnostics";
import { Assumptions } from "./Assumptions";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

export interface ResultsPanelProps {
  job: JobView | null;
  summary: RunSummary | null;
  problem: ApiProblem | null;
  catalog?: Catalog | null;
  model?: ModelFile | null;
  manifest?: RunManifest | null;
  stale?: boolean;
  activeVariantId?: string | null;
  selectedPointId?: string;
  onPointChange?: (pointId: string) => void;
  diagnostics?: readonly Diagnostic[];
  validationPending?: boolean;
  validationProblem?: ApiProblem | null;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

function progressOf(job: JobView): string {
  return `${job.status} · ${job.completedTasks}/${job.totalTasks === 0 ? "?" : job.totalTasks} tasks`;
}

/** Results and validation diagnostics below the canvas (product vision §5.5). */
export function ResultsPanel({
  job, summary, problem, catalog = null, model = null, manifest = null, stale = false,
  activeVariantId = null, selectedPointId = "p0", onPointChange,
  diagnostics = [], validationPending = false, validationProblem = null, onDiagnostic,
}: ResultsPanelProps) {
  const [active, setActive] = useState("summary");
  const id = useId();
  const points = summary?.variants[0]?.points ?? [];
  const staleNotice = stale ? <p className="banner" role="status">Results belong to a previous document version.</p> : null;
  return (
    <section className="results-panel" aria-label="Results">
      <div role="tablist" aria-label="Result views">
        <button id={`${id}-summary`} type="button" role="tab" aria-selected={active === "summary"}
          aria-controls={`${id}-panel`} onClick={() => setActive("summary")}>
          Summary
        </button>
        <button id={`${id}-assumptions`} type="button" role="tab" aria-selected={active === "assumptions"}
          aria-controls={`${id}-panel`} onClick={() => setActive("assumptions")}>
          Assumptions
        </button>
        <button id={`${id}-problems`} type="button" role="tab" aria-label="Problems" aria-selected={active === "problems"}
          aria-controls={`${id}-panel`} onClick={() => setActive("problems")}>
          Problems ({diagnostics.length})
        </button>
      </div>
      <div id={`${id}-panel`} className="results-body" role="tabpanel" aria-labelledby={`${id}-${active}`} tabIndex={0}>
        {active === "problems" ? <>
          {validationPending ? <p role="status">Validating documents…</p> : null}
          {validationProblem === null ? null : <ProblemList problem={validationProblem} />}
          <ul className="validation-problems">
            {diagnostics.map((diagnostic, index) => <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}>
              <button type="button" onClick={() => onDiagnostic?.(diagnostic)}>
                {diagnostic.severity} · {diagnostic.code} · {diagnostic.message} · {locationOf(diagnostic)}
              </button>
            </li>)}
          </ul>
          {!validationPending && validationProblem === null && diagnostics.length === 0 ? <p>No problems.</p> : null}
        </> : active === "assumptions" ? <>
          {staleNotice}
          {catalog === null || model === null ? <p className="results-empty">Run the experiment to see model assumptions.</p> :
            <Assumptions catalog={catalog} model={model} manifest={manifest} />}
        </> : <>
          {staleNotice}
          {job?.status === "CANCELLED" ? (
            <p className="results-empty">Run cancelled; the run is incomplete and has no summary.</p>
          ) : problem !== null ? (
            <ProblemList problem={problem} />
          ) : summary !== null ? (
            <>
              {summary.grid.length > 0 ? <div className="summary-toolbar">
                <label htmlFor={`${id}-point`}>Grid point</label>
                <select id={`${id}-point`} value={selectedPointId} onChange={(event) => onPointChange?.(event.target.value)}>
                  {points.map((point) => <option key={point.id} value={point.id}>
                    {point.id}{Object.entries(point.coordinates).length === 0 ? "" : ` · ${Object.entries(point.coordinates)
                      .map(([path, value]) => `${path} = ${typeof value === "string" ? value : JSON.stringify(value)}`).join(", ")}`}
                  </option>)}
                </select>
              </div> : null}
              <SummaryTable summary={summary} activeVariantId={activeVariantId} selectedPointId={selectedPointId} />
            </>
          ) : (
            <p className="results-empty">{job === null ? "Run the experiment to see results." : progressOf(job)}</p>
          )}
        </>}
      </div>
    </section>
  );
}
