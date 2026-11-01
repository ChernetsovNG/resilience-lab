import { courseData, runConditions } from "../experiment/course";
import { applyOverrides } from "../workspace/params";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import type { ApiProblem, Catalog, Diagnostic, ExperimentFile, JobView, ModelFile, RunManifest, RunSummary } from "../api/apiTypes";
import { diagnosticTarget, groupDiagnostics, locationOf } from "../validation/diagnostics";
import { LintDetails } from "../validation/DiagnosticDisplay";
import { HelpHint } from "../help/HelpHint";
import type { LoadedExperiment } from "../workspace/editor";
import { Assumptions } from "./Assumptions";
import { ProblemList } from "./ProblemList";
import { SummaryTable } from "./SummaryTable";
import { diagnosticGroupContext, elementLabel, parameterLabel, variantLabel } from "../presentation/labels";
import { sweepDiagnostics } from "../inspector/sweepDiagnostics";

const Timeline = lazy(() => import("../results/timeline/Timeline").then((module) => ({ default: module.Timeline })));
const GridMap = lazy(() => import("../results/GridMap").then((module) => ({ default: module.GridMap })));

export type ResultsPanelSize = "collapsed" | "normal" | "expanded";
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
  onElement?: (id: string) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  diagnosticDocuments?: Pick<LoadedExperiment, "model" | "modelPath" | "experiment" | "experimentPath"> | null;
  /** Incremented by the status bar, a variant badge or a newly received error; ordinary rerenders preserve the selected tab. */
  problemsRequest?: number;
  problemsElement?: string | null;
  onClearProblemsElement?: () => void;
  timelineRequest?: number;
}

/** Results and validation diagnostics below the canvas (product vision §5.5). */
export function ResultsPanel({
  job, summary, problem, running = job?.status === "RUNNING" || job?.status === "QUEUED", catalog = null, model = null, manifest = null, stale = false,
  activeVariantId = null, selectedPointId = "p0", onPointChange, size = "normal", onSizeChange, onViewChange,
  runId = null, experiment = null, selectedNodes = [], replication = 0, cursorWindow = null, onCursorChange,
  diagnostics = [], validationPending = false, validationProblem = null, onDiagnostic, onElement, diagnosticDocuments = null, problemsRequest = 0, problemsElement = null, onClearProblemsElement, timelineRequest = 0,
}: ResultsPanelProps) {
  const [navigation, setNavigation] = useState({ view: "answer" as ResultsPanelView, running, changedDuringRun: false, completedJob: null as string | null, problemsRequest, timelineRequest: 0 });
  const completedJob = !running && job?.status === "COMPLETED" && summary !== null && problem === null ? job.id : null;
  const revealTimeline = timelineRequest !== navigation.timelineRequest;
  const revealProblems = problemsRequest !== navigation.problemsRequest;
  // Adjust navigation once per run; a choice made while submission is pending also counts.
  if (revealTimeline || revealProblems || running !== navigation.running || (completedJob !== null && completedJob !== navigation.completedJob)) {
    const starting = running && !navigation.running;
    const finished = completedJob !== null && completedJob !== navigation.completedJob;
    setNavigation({
      view: revealProblems ? "problems" : revealTimeline ? "timeline" : finished && !(navigation.running && navigation.changedDuringRun) ? "answer" : navigation.view,
      running,
      changedDuringRun: (starting ? false : navigation.changedDuringRun) || (revealProblems && running),
      completedJob: completedJob ?? navigation.completedJob,
      problemsRequest, timelineRequest,
    });
  }
  const hasGrid = summary !== null && summary.grid.length > 0;
  const active = navigation.view === "map" && !hasGrid ? "answer" : navigation.view;
  useEffect(() => { onViewChange?.(active); }, [active, onViewChange]);
  const selectView = (view: ResultsPanelView) => {
    setNavigation({
      ...navigation, view, changedDuringRun: navigation.changedDuringRun || (running && view !== active),
    });
    if (size === "collapsed") onSizeChange?.("normal");
  };
  const [timelineOpened, setTimelineOpened] = useState(false);
  const id = useId();
  const visibleDiagnostics = problemsElement === null ? diagnostics : diagnostics.filter(diagnostic =>
    (diagnosticDocuments === null ? diagnostic.path : diagnosticTarget(diagnostic, diagnosticDocuments).element) === problemsElement);
  const diagnosticExperiment = diagnosticDocuments?.experiment ?? experiment;
  const diagnosticModel = diagnosticDocuments?.model ?? model;
  const diagnosticGrid = diagnosticExperiment?.grid ?? summary?.grid ?? [];
  const diagnosticVariants = diagnosticExperiment?.variants ?? summary?.variants ?? [];
  const diagnosticLabels = new Map(diagnosticGrid.map(axis => [axis.path, parameterLabel(axis.path, catalog, diagnosticModel)]));
  const diagnosticContext = { catalog, model: diagnosticModel, grid: diagnosticGrid, variants: diagnosticVariants };
  const runDiagnosticContext = { catalog, model, grid: experiment?.grid ?? summary?.grid ?? [],
    variants: experiment?.variants ?? summary?.variants ?? [] };
  const staleNotice = running && summary !== null ? <p className="banner" role="status">{t("results.staleRunning")}</p>
    : stale ? <p className="banner" role="status">{t("results.stale")}</p> : null;
  const conditionVariant = activeVariantId ?? summary?.variants[0]?.id;
  const faults = model === null || experiment === null || catalog === null ? [] : courseData(model, experiment, catalog).faults;
  const conditions = model === null || experiment === null || catalog === null ? null : runConditions(
    applyOverrides(applyOverrides(model, experiment.variants.find(variant => variant.id === conditionVariant)?.overrides ?? {}, catalog),
      summary?.variants.find(variant => variant.id === conditionVariant)?.points.find(point => point.id === selectedPointId)?.coordinates ?? {}, catalog), experiment, catalog);
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
          aria-controls={`${id}-panel`} onClick={() => { onClearProblemsElement?.(); selectView("problems"); }}>
          {t("results.problems.count", { count: formatNumber(groupDiagnostics(diagnostics).length) })}
        </button>
        <span className="results-size-actions">
          {size === "normal" ? <button type="button" onClick={() => onSizeChange?.("expanded")}>{t("results.expand")}</button> : null}
          {size === "expanded" ? <button type="button" onClick={() => onSizeChange?.("normal")}>{t("results.unexpand")}</button> : null}
          {size === "normal" ? <button type="button" onClick={() => onSizeChange?.("collapsed")}>{t("results.collapse")}</button> : null}
          {size === "collapsed" ? <button type="button" onClick={() => onSizeChange?.("normal")}>{t("results.restore")}</button> : null}
        </span>
      </div>
      <div id={`${id}-panel`} className="results-body" role="tabpanel" aria-labelledby={`${id}-${active}`} tabIndex={0}
        hidden={size === "collapsed"}>
        {problem === null ? null : <ProblemList problem={{ ...problem, diagnostics: [] }} context={runDiagnosticContext} />}
        {active === "problems" ? <>
          {validationPending ? <p role="status">{t("results.problems.validating")}</p> : null}
          {validationProblem === null ? null : <ProblemList problem={{ ...validationProblem, diagnostics: [] }} context={diagnosticContext} />}
          {problemsElement === null ? null : <p className="problems-filter">
            {t("results.problems.elementFilter", { element: elementLabel(problemsElement, diagnosticModel) })}
            <button type="button" onClick={onClearProblemsElement}>{t("results.problems.showAll")}</button>
          </p>}
          <ul className="validation-problems">
            {groupDiagnostics(visibleDiagnostics).sort((left, right) => Number(right.diagnostic.severity === "ERROR") - Number(left.diagnostic.severity === "ERROR"))
              .map((group, index) => {
                const { diagnostic, members } = group;
                const lint = diagnostic.code.startsWith("LINT_");
                const original = members[0];
                const target = diagnosticDocuments === null ? { element: diagnostic.path, variant: diagnostic.variant } : diagnosticTarget(original, diagnosticDocuments);
                return <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}>
                  <button type="button" data-diagnostic-code={diagnostic.code} title={locationOf(original)} onClick={() => onDiagnostic?.(original)}>
                    <span role="img" aria-label={t(`results.problems.severity.${diagnostic.severity}`)}>{t(`results.problems.icon.${diagnostic.severity}`)}</span>
                    <span>
                      <span className="diagnostic-message">{sweepDiagnostics([{ ...diagnostic, variant: undefined }],
                        { grid: diagnosticGrid, variants: diagnosticVariants }, diagnosticLabels, catalog, diagnosticModel)[0].message}</span>
                      <span className="diagnostic-context">{lint ? [elementLabel(diagnostic.path ?? target.element ?? t("common.experiment"), diagnosticModel),
                        diagnosticGroupContext(group, diagnosticVariants)].filter(Boolean).join("; ") : t("results.problems.context", {
                        element: elementLabel(target.element ?? t("common.experiment"), diagnosticModel),
                        variant: target.variant == null ? "" : t("results.problems.variant", {
                          variant: variantLabel(diagnosticVariants.find(variant => variant.id === target.variant) ?? { id: target.variant }, diagnosticVariants),
                        }),
                      })}</span>
                      {lint ? null : <span className="diagnostic-details">{t("results.problems.details", {
                        code: diagnostic.code, document: diagnostic.document ?? t("common.experiment"),
                      })}</span>}
                    </span>
                  </button>
                  {lint ? <HelpHint label={t("results.problems.explanation")}><LintDetails diagnostic={diagnostic} />
                    {[...new Set(members.map(locationOf))].map(location => <p key={location} className="diagnostic-details">{location}</p>)}
                  </HelpHint> : null}
                </li>;
              })}
          </ul>
          {!validationPending && validationProblem === null && visibleDiagnostics.length === 0 ? <p>{t("results.problems.none")}</p> : null}
        </> : active === "timeline" ? <>
          {staleNotice}
          {summary === null || manifest === null || model === null || experiment === null || catalog === null || runId === null ?
            <p className="results-empty" role={running ? "status" : undefined}>{t(running ? "results.awaitingSummary" : "results.timeline.empty")}</p> : null}
        </> : active === "map" && summary !== null ? <>
          {staleNotice}
          <Suspense fallback={<p role="status">{t("results.map.loading")}</p>}><GridMap onElement={onElement} summary={summary} activeVariantId={activeVariantId}
            pointId={selectedPointId} onPointChange={onPointChange} catalog={catalog} model={model} variants={experiment?.variants} /></Suspense>
        </> : active === "assumptions" ? <>
          {staleNotice}
          {catalog === null || model === null ? <p className="results-empty">{t("results.assumptions.empty")}</p> :
            <Assumptions catalog={catalog} model={model} manifest={manifest} />}
        </> : <>
          {staleNotice}
          {summary !== null ? (
            <>
              {conditions === null ? null : <p className="run-conditions" data-testid="run-conditions" title={conditions}>{conditions}</p>}
              <SummaryTable summary={summary} activeVariantId={activeVariantId} selectedPointId={selectedPointId} onElement={onElement}
                faults={faults} windowMs={manifest?.series?.windowMs} catalog={catalog} model={model} variants={experiment?.variants} />
            </>
          ) : problem !== null ? null : job?.status === "CANCELLED" ? (
            <p className="results-empty">{t("results.cancelled")}</p>
          ) : (
            <p className="results-empty" role={running ? "status" : undefined}>{job === null && !running ? t("results.empty") : t("results.awaitingSummary")}</p>
          )}
        </>}
        {(timelineOpened || timelineRequest > 0) && summary !== null && manifest !== null && model !== null && experiment !== null && catalog !== null && runId !== null ?
          <div hidden={active !== "timeline"}>
            <Suspense fallback={<p role="status">{t("results.timeline.loading")}</p>}><Timeline runId={runId} summary={summary} manifest={manifest} model={model} experiment={experiment} catalog={catalog}
              enabled={active === "timeline" && size !== "collapsed"} activeVariantId={activeVariantId} pointId={selectedPointId}
              replication={replication} cursorWindow={cursorWindow} selectedNodes={selectedNodes} selectionRequest={timelineRequest}
              onCursorChange={onCursorChange} /></Suspense>
          </div> : null}
      </div>
    </section>
  );
}
