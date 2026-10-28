import { lazy, Suspense, useId, useState } from "react";
import type { ApiProblem, Catalog, Diagnostic, ExperimentFile, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { locationOf } from "../validation/diagnostics";
import { Assumptions } from "./Assumptions";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

const Timeline = lazy(() => import("../results/timeline/Timeline").then((module) => ({ default: module.Timeline })));

export type ResultsPanelSize = "collapsed" | "normal" | "expanded";

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
  runId?: string | null;
  experiment?: ExperimentFile | null;
  selectedNodes?: readonly string[];
  replication?: number;
  onReplicationChange?: (replication: number) => void;
  cursorWindow?: number | null;
  onCursorChange?: (window: number | null) => void;
  size?: ResultsPanelSize;
  onSizeChange?: (size: ResultsPanelSize) => void;
  diagnostics?: readonly Diagnostic[];
  validationPending?: boolean;
  validationProblem?: ApiProblem | null;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

function progressOf(job: JobView): string {
  const cancelling = job.cancelRequested && (job.status === "QUEUED" || job.status === "RUNNING");
  return `${job.status} · ${job.completedTasks}/${job.totalTasks === 0 ? "?" : job.totalTasks} tasks${cancelling ? " · cancellation requested" : ""}`;
}

/** Results and validation diagnostics below the canvas (product vision §5.5). */
export function ResultsPanel({
  job, summary, problem, catalog = null, model = null, manifest = null, stale = false,
  activeVariantId = null, selectedPointId = "p0", onPointChange, size = "normal", onSizeChange,
  runId = null, experiment = null, selectedNodes = [], replication = 0, onReplicationChange, cursorWindow = null, onCursorChange,
  diagnostics = [], validationPending = false, validationProblem = null, onDiagnostic,
}: ResultsPanelProps) {
  const [active, setActive] = useState("summary");
  const [timelineOpened, setTimelineOpened] = useState(false);
  const id = useId();
  const points = summary?.variants[0]?.points ?? [];
  const staleNotice = stale ? <p className="banner" role="status">Results belong to a previous document version.</p> : null;
  return (
    <section className={`results-panel results-panel--${size}`} aria-label="Results">
      <div role="tablist" aria-label="Result views">
        <button id={`${id}-summary`} type="button" role="tab" aria-selected={active === "summary"}
          aria-controls={`${id}-panel`} onClick={() => setActive("summary")}>
          Summary
        </button>
        <button id={`${id}-timeline`} type="button" role="tab" aria-selected={active === "timeline"}
          aria-controls={`${id}-panel`} onClick={() => { setTimelineOpened(true); setActive("timeline"); }}>
          Timeline
        </button>
        <button id={`${id}-assumptions`} type="button" role="tab" aria-selected={active === "assumptions"}
          aria-controls={`${id}-panel`} onClick={() => setActive("assumptions")}>
          Assumptions
        </button>
        <button id={`${id}-problems`} type="button" role="tab" aria-label="Problems" aria-selected={active === "problems"}
          aria-controls={`${id}-panel`} onClick={() => setActive("problems")}>
          Problems ({diagnostics.length})
        </button>
        <span className="results-size-actions">
          {size === "normal" ? <button type="button" onClick={() => onSizeChange?.("collapsed")}>Collapse results</button> : null}
          {size !== "normal" ? <button type="button" onClick={() => onSizeChange?.("normal")}>Restore results</button> : null}
          {size !== "expanded" ? <button type="button" onClick={() => onSizeChange?.("expanded")}>Expand results</button> : null}
        </span>
        <span className="results-job-status" data-testid="results-job-status" role="status">
          {job === null ? "" : progressOf(job)}
        </span>
      </div>
      <div id={`${id}-panel`} className="results-body" role="tabpanel" aria-labelledby={`${id}-${active}`} tabIndex={0}
        hidden={size === "collapsed"}>
        {problem === null ? null : <ProblemList problem={problem} />}
        {(active === "summary" || active === "timeline") && summary !== null && summary.grid.length > 0 ? <div className="summary-toolbar">
          <label htmlFor={`${id}-point`}>Grid point</label>
          <select id={`${id}-point`} value={selectedPointId} onChange={(event) => onPointChange?.(event.target.value)}>
            {points.map((point) => <option key={point.id} value={point.id}>
              {point.id}{Object.entries(point.coordinates).length === 0 ? "" : ` · ${Object.entries(point.coordinates)
                .map(([path, value]) => `${path} = ${typeof value === "string" ? value : JSON.stringify(value)}`).join(", ")}`}
            </option>)}
          </select>
        </div> : null}
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
        </> : active === "timeline" ? <>
          {staleNotice}
          {summary === null || manifest === null || model === null || experiment === null || catalog === null || runId === null ?
            <p className="results-empty">Run the experiment to see the timeline.</p> : null}
        </> : active === "assumptions" ? <>
          {staleNotice}
          {catalog === null || model === null ? <p className="results-empty">Run the experiment to see model assumptions.</p> :
            <Assumptions catalog={catalog} model={model} manifest={manifest} />}
        </> : <>
          {staleNotice}
          {problem !== null ? null : job?.status === "CANCELLED" ? (
            <p className="results-empty">Run cancelled; the run is incomplete and has no summary.</p>
          ) : summary !== null ? (
            <>
              <SummaryTable summary={summary} activeVariantId={activeVariantId} selectedPointId={selectedPointId} />
            </>
          ) : (
            <p className="results-empty">{job === null ? "Run the experiment to see results." : progressOf(job)}</p>
          )}
        </>}
        {timelineOpened && summary !== null && manifest !== null && model !== null && experiment !== null && catalog !== null && runId !== null ?
          <div hidden={active !== "timeline"}>
            <Suspense fallback={<p role="status">Loading timeline…</p>}><Timeline runId={runId} summary={summary} manifest={manifest} model={model} experiment={experiment} catalog={catalog}
              enabled={active === "timeline" && size !== "collapsed"} activeVariantId={activeVariantId} pointId={selectedPointId}
              replication={replication} cursorWindow={cursorWindow} selectedNodes={selectedNodes}
              onReplicationChange={onReplicationChange} onCursorChange={onCursorChange} /></Suspense>
          </div> : null}
      </div>
    </section>
  );
}
