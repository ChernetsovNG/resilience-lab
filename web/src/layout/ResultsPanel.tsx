import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { ApiProblem, Catalog, Diagnostic, ExperimentFile, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { diagnosticTarget, locationOf } from "../validation/diagnostics";
import type { LoadedExperiment } from "../workspace/editor";
import { Assumptions } from "./Assumptions";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";

const Timeline = lazy(() => import("../results/timeline/Timeline").then((module) => ({ default: module.Timeline })));
const GridMap = lazy(() => import("../results/GridMap").then((module) => ({ default: module.GridMap })));

export type ResultsPanelSize = "collapsed" | "normal";
export type ResultsPanelView = "answer" | "timeline" | "assumptions" | "map" | "problems";

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
  cursorWindow?: number | null;
  onCursorChange?: (window: number | null) => void;
  size?: ResultsPanelSize;
  onSizeChange?: (size: ResultsPanelSize) => void;
  onViewChange?: (view: ResultsPanelView) => void;
  diagnostics?: readonly Diagnostic[];
  validationPending?: boolean;
  validationProblem?: ApiProblem | null;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  diagnosticDocuments?: Pick<LoadedExperiment, "model" | "modelPath" | "experiment" | "experimentPath"> | null;
  /** Incremented by the status bar or a newly received error; ordinary rerenders preserve the selected tab. */
  problemsRequest?: number;
}

/** Results and validation diagnostics below the canvas (product vision §5.5). */
export function ResultsPanel({
  job, summary, problem, running = job?.status === "RUNNING" || job?.status === "QUEUED", catalog = null, model = null, manifest = null, stale = false,
  activeVariantId = null, selectedPointId = "p0", onPointChange, size = "normal", onSizeChange, onViewChange,
  runId = null, experiment = null, selectedNodes = [], replication = 0, cursorWindow = null, onCursorChange,
  diagnostics = [], validationPending = false, validationProblem = null, onDiagnostic, diagnosticDocuments = null, problemsRequest = 0,
}: ResultsPanelProps) {
  const [navigation, setNavigation] = useState({ view: "answer" as ResultsPanelView, running, changedDuringRun: false, completedJob: null as string | null, problemsRequest });
  const completedJob = !running && job?.status === "COMPLETED" && summary !== null && problem === null ? job.id : null;
  const revealProblems = problemsRequest !== navigation.problemsRequest;
  // Adjust navigation once per run; a choice made while submission is pending also counts.
  if (revealProblems || running !== navigation.running || (completedJob !== null && completedJob !== navigation.completedJob)) {
    const starting = running && !navigation.running;
    const finished = completedJob !== null && completedJob !== navigation.completedJob;
    setNavigation({
      view: revealProblems ? "problems" : finished && !(navigation.running && navigation.changedDuringRun) ? "answer" : navigation.view,
      running,
      changedDuringRun: (starting ? false : navigation.changedDuringRun) || (revealProblems && running),
      completedJob: completedJob ?? navigation.completedJob,
      problemsRequest,
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
  useEffect(() => { onViewChange?.(active); }, [active, onViewChange]);
  const selectView = (view: ResultsPanelView) => setNavigation({
    ...navigation, view, changedDuringRun: navigation.changedDuringRun || (running && view !== active),
  });
  const [timelineOpened, setTimelineOpened] = useState(false);
  const id = useId();
  const staleNotice = stale ? <p className="banner" role="status">{t("results.stale")}</p> : null;
  return (
    <section id="results-panel" className={`results-panel results-panel--${size}`} aria-label={t("results.title")}>
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
        </span>
      </div>
      <div id={`${id}-panel`} className="results-body" role="tabpanel" aria-labelledby={`${id}-${active}`} tabIndex={0}
        hidden={size === "collapsed"}>
        {problem === null ? null : <ProblemList problem={{ ...problem, diagnostics: [] }} />}
        {active === "problems" ? <>
          {validationPending ? <p role="status">{t("results.problems.validating")}</p> : null}
          {validationProblem === null ? null : <ProblemList problem={{ ...validationProblem, diagnostics: [] }} />}
          <ul className="validation-problems">
            {[...diagnostics].sort((left, right) => Number(right.severity === "ERROR") - Number(left.severity === "ERROR"))
              .map((diagnostic, index) => {
                const target = diagnosticDocuments === null ? { element: diagnostic.path, variant: diagnostic.variant } : diagnosticTarget(diagnostic, diagnosticDocuments);
                return <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}>
                  <button type="button" title={locationOf(diagnostic)} onClick={() => onDiagnostic?.(diagnostic)}>
                    <span role="img" aria-label={t(`results.problems.severity.${diagnostic.severity}`)}>{t(`results.problems.icon.${diagnostic.severity}`)}</span>
                    <span>
                      <span className="diagnostic-message">{diagnostic.message}</span>
                      <span className="diagnostic-context">{t("results.problems.context", {
                        element: target.element ?? t("common.experiment"),
                        variant: target.variant == null ? "" : t("results.problems.variant", { variant: target.variant }),
                      })}</span>
                      <span className="diagnostic-details">{t("results.problems.details", {
                        code: diagnostic.code, document: diagnostic.document ?? t("common.experiment"),
                      })}</span>
                    </span>
                  </button>
                </li>;
              })}
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
            <p className="results-empty">{job === null ? t("results.empty") : t("results.awaitingSummary")}</p>
          )}
        </>}
        {timelineOpened && summary !== null && manifest !== null && model !== null && experiment !== null && catalog !== null && runId !== null ?
          <div hidden={active !== "timeline"}>
            <Suspense fallback={<p role="status">{t("results.timeline.loading")}</p>}><Timeline runId={runId} summary={summary} manifest={manifest} model={model} experiment={experiment} catalog={catalog}
              enabled={active === "timeline" && size !== "collapsed"} activeVariantId={activeVariantId} pointId={selectedPointId}
              replication={replication} cursorWindow={cursorWindow} selectedNodes={selectedNodes}
              onCursorChange={onCursorChange} /></Suspense>
          </div> : null}
      </div>
    </section>
  );
}
