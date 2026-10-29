import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { ApiProblem, Catalog, Diagnostic, ExperimentFile, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { locationOf } from "../validation/diagnostics";
import { Assumptions } from "./Assumptions";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

const Timeline = lazy(() => import("../results/timeline/Timeline").then((module) => ({ default: module.Timeline })));
const GridMap = lazy(() => import("../results/GridMap").then((module) => ({ default: module.GridMap })));

export type ResultsPanelSize = "collapsed" | "normal" | "expanded";

export interface ResultsPanelProps {
  job: JobView | null;
  summary: RunSummary | null;
  problem: ApiProblem | null;
  running?: boolean;
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
  return t("results.progress", {
    status: t(`results.jobStatus.${job.status}`), completed: formatNumber(job.completedTasks),
    total: job.totalTasks === 0 ? t("results.unknownTotal") : formatNumber(job.totalTasks),
    cancelling: cancelling ? t("results.cancellationRequested") : "",
  });
}

/** Results and validation diagnostics below the canvas (product vision §5.5). */
export function ResultsPanel({
  job, summary, problem, running = job?.status === "RUNNING" || job?.status === "QUEUED", catalog = null, model = null, manifest = null, stale = false,
  activeVariantId = null, selectedPointId = "p0", onPointChange, size = "normal", onSizeChange,
  runId = null, experiment = null, selectedNodes = [], replication = 0, onReplicationChange, cursorWindow = null, onCursorChange,
  diagnostics = [], validationPending = false, validationProblem = null, onDiagnostic,
}: ResultsPanelProps) {
  const [navigation, setNavigation] = useState({ view: "answer", running, changedDuringRun: false, completedJob: null as string | null });
  const completedJob = !running && job?.status === "COMPLETED" && summary !== null && problem === null ? job.id : null;
  // Adjust navigation once per run; a choice made while submission is pending also counts.
  if (running !== navigation.running || (completedJob !== null && completedJob !== navigation.completedJob)) {
    const starting = running && !navigation.running;
    const finished = completedJob !== null && completedJob !== navigation.completedJob;
    setNavigation({
      view: finished && !(navigation.running && navigation.changedDuringRun) ? "answer" : navigation.view,
      running,
      changedDuringRun: starting ? false : navigation.changedDuringRun,
      completedJob: completedJob ?? navigation.completedJob,
    });
  }
  const restoredJob = useRef<string | null>(null);
  useEffect(() => {
    if (completedJob === null || restoredJob.current === completedJob) return;
    restoredJob.current = completedJob;
    if (size === "collapsed") onSizeChange?.("normal");
  }, [completedJob, size, onSizeChange]);
  const hasGrid = summary !== null && summary.grid.length > 0;
  const active = navigation.view === "map" && !hasGrid ? "answer" : navigation.view;
  const selectView = (view: string) => setNavigation({
    ...navigation, view, changedDuringRun: navigation.changedDuringRun || (running && view !== active),
  });
  const [timelineOpened, setTimelineOpened] = useState(false);
  const id = useId();
  const pointIds = new Set<string>();
  const points = (summary?.variants.flatMap(variant => variant.points) ?? []).filter(point => {
    if (pointIds.has(point.id)) return false;
    pointIds.add(point.id);
    return true;
  });
  const staleNotice = stale ? <p className="banner" role="status">{t("results.stale")}</p> : null;
  return (
    <section className={`results-panel results-panel--${size}`} aria-label={t("results.title")}>
      <div role="tablist" aria-label={t("results.views")}>
        <button id={`${id}-answer`} type="button" role="tab" aria-selected={active === "answer"}
          aria-controls={`${id}-panel`} onClick={() => selectView("answer")}>
          {t("results.answer.title")}
        </button>
        <button id={`${id}-timeline`} type="button" role="tab" aria-selected={active === "timeline"}
          aria-controls={`${id}-panel`} onClick={() => { setTimelineOpened(true); selectView("timeline"); }}>
          {t("results.timeline.title")}
        </button>
        <button id={`${id}-assumptions`} type="button" role="tab" aria-selected={active === "assumptions"}
          aria-controls={`${id}-panel`} onClick={() => selectView("assumptions")}>
          {t("results.assumptions.title")}
        </button>
        {hasGrid ? <button id={`${id}-map`} type="button" role="tab" aria-selected={active === "map"}
          aria-controls={`${id}-panel`} onClick={() => selectView("map")}>
          {t("results.map.title")}
        </button> : null}
        <button id={`${id}-problems`} type="button" role="tab" aria-label={t("results.problems.title")} aria-selected={active === "problems"}
          aria-controls={`${id}-panel`} onClick={() => selectView("problems")}>
          {t("results.problems.count", { count: formatNumber(diagnostics.length) })}
        </button>
        <span className="results-size-actions">
          {size === "normal" ? <button type="button" onClick={() => onSizeChange?.("collapsed")}>{t("results.collapse")}</button> : null}
          {size !== "normal" ? <button type="button" onClick={() => onSizeChange?.("normal")}>{t("results.restore")}</button> : null}
          {size !== "expanded" ? <button type="button" onClick={() => onSizeChange?.("expanded")}>{t("results.expand")}</button> : null}
        </span>
        <span className="results-job-status" data-testid="results-job-status" role="status">
          {job === null ? "" : progressOf(job)}
        </span>
      </div>
      <div id={`${id}-panel`} className="results-body" role="tabpanel" aria-labelledby={`${id}-${active}`} tabIndex={0}
        hidden={size === "collapsed"}>
        {problem === null ? null : <ProblemList problem={problem} />}
        {(active === "answer" || active === "timeline") && summary !== null && summary.grid.length > 0 ? <div className="summary-toolbar">
          <label htmlFor={`${id}-point`}>{t("results.gridPoint")}</label>
          <select id={`${id}-point`} value={selectedPointId} onChange={(event) => onPointChange?.(event.target.value)}>
            {points.map((point) => <option key={point.id} value={point.id}>
              {Object.entries(point.coordinates).length === 0 ? point.id : t("results.gridPointCoordinates", {
                point: point.id, coordinates: Object.entries(point.coordinates).map(([path, value]) =>
                  t("results.coordinate", { path, value: typeof value === "number" ? formatNumber(value) : typeof value === "string" ? value : JSON.stringify(value) })).join(t("results.coordinateSeparator")),
              })}
            </option>)}
          </select>
        </div> : null}
        {active === "problems" ? <>
          {validationPending ? <p role="status">{t("results.problems.validating")}</p> : null}
          {validationProblem === null ? null : <ProblemList problem={validationProblem} />}
          <ul className="validation-problems">
            {diagnostics.map((diagnostic, index) => <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}>
              <button type="button" onClick={() => onDiagnostic?.(diagnostic)}>
                {t("results.problems.diagnostic", { severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message, location: locationOf(diagnostic) })}
              </button>
            </li>)}
          </ul>
          {!validationPending && validationProblem === null && diagnostics.length === 0 ? <p>{t("results.problems.none")}</p> : null}
        </> : active === "timeline" ? <>
          {staleNotice}
          {summary === null || manifest === null || model === null || experiment === null || catalog === null || runId === null ?
            <p className="results-empty">{t("results.timeline.empty")}</p> : null}
        </> : active === "map" && summary !== null ? <>
          {staleNotice}
          <Suspense fallback={<p role="status">{t("results.map.loading")}</p>}><GridMap summary={summary} activeVariantId={activeVariantId}
            pointId={selectedPointId} onPointChange={onPointChange} /></Suspense>
        </> : active === "assumptions" ? <>
          {staleNotice}
          {catalog === null || model === null ? <p className="results-empty">{t("results.assumptions.empty")}</p> :
            <Assumptions catalog={catalog} model={model} manifest={manifest} />}
        </> : <>
          {staleNotice}
          {problem !== null ? null : job?.status === "CANCELLED" ? (
            <p className="results-empty">{t("results.cancelled")}</p>
          ) : summary !== null ? (
            <>
              <SummaryTable summary={summary} activeVariantId={activeVariantId} selectedPointId={selectedPointId} />
            </>
          ) : (
            <p className="results-empty">{job === null ? t("results.empty") : progressOf(job)}</p>
          )}
        </>}
        {timelineOpened && summary !== null && manifest !== null && model !== null && experiment !== null && catalog !== null && runId !== null ?
          <div hidden={active !== "timeline"}>
            <Suspense fallback={<p role="status">{t("results.timeline.loading")}</p>}><Timeline runId={runId} summary={summary} manifest={manifest} model={model} experiment={experiment} catalog={catalog}
              enabled={active === "timeline" && size !== "collapsed"} activeVariantId={activeVariantId} pointId={selectedPointId}
              replication={replication} cursorWindow={cursorWindow} selectedNodes={selectedNodes}
              onReplicationChange={onReplicationChange} onCursorChange={onCursorChange} /></Suspense>
          </div> : null}
      </div>
    </section>
  );
}
