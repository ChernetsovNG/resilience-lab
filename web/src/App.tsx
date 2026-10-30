import { ExperimentCourse } from "./experiment/ExperimentCourse";
import { courseData } from "./experiment/course";
import { backendMessage } from "./i18n/backendMessage";
import { CostEstimate } from "./run/CostEstimate";
import { useEstimate } from "./run/useEstimate";

import { canvasResults, type ConnectionOverlayMetric, type NodeOverlayMetric } from "./results/canvasResults";
import { ResultsContextBar } from "./results/ResultsContextBar";
import { EstimatePopover } from "./run/EstimatePopover";
import { usePlayback } from "./results/playback/usePlayback";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import type { Diagnostic, ModelFile, Variant } from "./api/apiTypes";
import { diagnosticKey, diagnosticTarget, mergeDiagnostics, problemDiagnostics } from "./validation/diagnostics";
import { useValidation } from "./validation/useValidation";
import { Canvas, type CanvasHandle } from "./canvas/Canvas";
import { VariantTabs } from "./canvas/VariantTabs";
import { VariantChanges } from "./canvas/VariantChanges";
import { useHealth } from "./components/useHealth";
import { ElementResults, type ElementResultsProps } from "./inspector/ElementResults";
import { projectElementResults } from "./inspector/elementResultsData";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./layout/Palette";
import { ProblemList } from "./layout/ProblemList";
import { ResultsWorkspace } from "./layout/ResultsWorkspace";
import { ResultsPanel, type ResultsPanelSize, type ResultsPanelView } from "./layout/ResultsPanel";
import { TopBar } from "./layout/TopBar";
import { FileMenu } from "./layout/FileMenu";
import { StatusBar } from "./layout/StatusBar";
import { currentViewSettings } from "./layout/viewSettings";
import { useRun, type RunDocuments } from "./run/useRun";
import { useResultsSelection } from "./results/selection";
import { setVariantParam } from "./workspace/experimentCommands";
import { documentValuesEqual, elementIdentity } from "./workspace/editor";
import { applyOverrides, elementOf } from "./workspace/params";
import { copySelection, deleteElements, pasteSelection, renameElement, type ClipboardFragment } from "./workspace/structure";
import { useWorkspace } from "./workspace/useWorkspace";

/**
 * One-screen layout (product vision §5.5, stage 1 design §6.1). The model page edits the model; a variant page edits the
 * variant's parameter overrides. Run settings and faults belong to the shared experiment. Results are shown
 * only for the experiment they were computed for.
 */
export function App() {
  const workspace = useWorkspace();
  const canvas = useRef<CanvasHandle>(null);
  const run = useRun();
  const [runPending, setRunPending] = useState(false);
  const health = useHealth();
  /** Selection follows variant identity across list edits and its ID across rename/undo/redo; null shows the model. */
  const [variantPage, setVariantPage] = useState<{ id: string | null; variants: Variant[] }>({ id: null, variants: [] });
  const results = useResultsSelection(run.job?.id ?? null);
  const [nodeMetric, setNodeMetric] = useState<NodeOverlayMetric | "off">("utilization");
  const [connectionMetric, setConnectionMetric] = useState<ConnectionOverlayMetric>("amplification");
  const [timelineRequest, setTimelineRequest] = useState(0);
  const showDiagramResults = nodeMetric !== "off";
  const [estimatePanel, setEstimatePanel] = useState<{ source: "manual" } | { source: "run"; previousJobId: string | null } | null>(null);
  const showEstimate = estimatePanel !== null && (estimatePanel.source === "manual" || run.job === null ||
    estimatePanel.previousJobId === run.job.id);
  const [resultsSize, setResultsSize] = useState<ResultsPanelSize>("collapsed");
  const [resultsView, setResultsView] = useState<ResultsPanelView>("answer");
  const [analysis, setAnalysis] = useState(false);
  const [problemsRequest, setProblemsRequest] = useState(0);
  const [problemsElement, setProblemsElement] = useState<string | null>(null);
  const [canvasZoom, setCanvasZoom] = useState<number | null>(null);
  const [launchDocuments, setLaunchDocuments] = useState<RunDocuments | null>(null);
  const [observedErrors, setObservedErrors] = useState<{ path: string | null; validation: string; run: string }>({ path: null, validation: "[]", run: "[]" });
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionModel, setSelectionModel] = useState<ModelFile | null>(null);
  const [courseHeight, setCourseHeight] = useState(0);
  const [faultRequest, setFaultRequest] = useState(0);
  const [inspectorTarget, setInspectorTarget] = useState<"element" | "variant" | "experiment">("experiment");
  const [fieldFocus, setFieldFocus] = useState<{ path: string; request: number; focus?: boolean } | null>(null);
  const clipboard = useRef<{ path: string; fragment: ClipboardFragment; offset: number } | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const { loaded, catalog, loading, undo, redo, execute } = workspace;
  let currentSelection = selection;
  if (loaded !== null && loaded.model !== selectionModel) {
    if (selectionModel !== null && selection.length > 0) {
      const elements = [...Object.entries(loaded.model.blocks), ...loaded.model.connections.map(edge => [edge.id, edge] as const)];
      const reconciled = selection.map(id => {
        const previous = elementOf(selectionModel, id);
        if (previous === null) return elementOf(loaded.model, id) === null ? null : id;
        const current = elements.find(([, element]) => elementIdentity(element) === elementIdentity(previous));
        return current?.[0] ?? null;
      });
      currentSelection = reconciled.filter(id => id !== null);
      if (inspectorTarget === "element" && reconciled.at(-1) === null) setInspectorTarget("experiment");
      if (currentSelection.length !== selection.length || currentSelection.some((id, index) => id !== selection[index])) setSelection(currentSelection);
    }
    setSelectionModel(loaded.model);
  }
  const selected = currentSelection.at(-1) ?? null;
  const hasClient = loaded !== null && Object.values(loaded.model.blocks).some(block => block.type === "client");
  const validation = useValidation(loaded, hasClient);
  const estimate = useEstimate(loaded, invalidFields);
  const variants = loaded?.experiment.variants ?? [];
  let variantId = variantPage.id;
  if (loaded !== null && variantPage.variants !== variants) {
    if (variantId !== null && !variants.some((candidate) => candidate.id === variantId)) {
      const index = variantPage.variants.findIndex((candidate) => candidate.id === variantId);
      const renamed = index >= 0 && variants.length === variantPage.variants.length &&
        variantPage.variants.every((previous, position) => position === index || previous.id === variants[position].id);
      variantId = renamed ? variants[index].id : null;
    }
    setVariantPage({ id: variantId, variants });
  }
  const selectVariant = (id: string | null) => setVariantPage({ id, variants });
  let target = inspectorTarget;
  if ((target === "element" && selected === null) || (target === "variant" && variantId === null)) {
    target = "experiment";
    setInspectorTarget(target);
  }
  const variant = variants.find((candidate) => candidate.id === variantId);
  const overrides = variant?.overrides ?? {};
  const editable = !workspace.loading;
  const structureEditable = editable && variant === undefined;
  const model = loaded === null || catalog === null ? null : applyOverrides(loaded.model, overrides, catalog);
  const invalid = invalidFields.size > 0;
  const selectVariantChange = (id: string, path: string) => {
    if (invalid || loading) return;
    setAnalysis(false);
    setSelection([id]); setInspectorTarget("element");
    setFaultRequest(current => current + 1);
    setFieldFocus(previous => ({ path, request: (previous?.request ?? 0) + 1 }));
  };
  const ownRun = loaded !== null && run.experiment === loaded.experimentPath;
  const staleResults = ownRun && loaded !== null && run.documents !== null && (
    !documentValuesEqual(loaded.model, run.documents.model) || !documentValuesEqual(loaded.experiment, run.documents.experiment)
  );
  const selectedPointId = results.selection.pointId;
  const summaryDiagramResults = ownRun && run.summary !== null && run.documents !== null && variant !== undefined && catalog !== null
    ? canvasResults(run.summary, run.documents.model, variant.id, selectedPointId, catalog, loaded.model, run.documents.experiment) : null;
  const seriesMetadata = ownRun ? run.manifest?.series : null;
  const endMs = (seriesMetadata?.warmupMs ?? 0) + (seriesMetadata?.measurementMs ?? 0);
  const windowMs = seriesMetadata?.windowMs ?? 1;
  const windowCount = Math.ceil(endMs / windowMs);
  const playback = usePlayback({
    runId: run.job?.runId ?? "", variant: showDiagramResults ? variant?.id ?? null : null,
    pointId: selectedPointId, replication: results.selection.replication, window: results.selection.window,
    windowCount, nodes: ownRun && run.documents !== null ? Object.keys(run.documents.model.blocks) : [],
    results: summaryDiagramResults, onWindowChange: (window) => results.select({ window }),
  });
  const diagramResults = results.selection.window === null ? summaryDiagramResults : playback.frame;
  const elementResults: ElementResultsProps | null = selected === null || !ownRun || run.job?.status !== "COMPLETED" || run.summary === null || run.manifest === null || run.documents === null || variant === undefined || catalog === null ? null : {
    runId: run.job.runId!, summary: run.summary, manifest: run.manifest,
    runModel: run.documents.model, currentModel: loaded.model, experiment: run.documents.experiment,
    catalog, variantId: variant.id, pointId: selectedPointId, replication: results.selection.replication,
    window: results.selection.window, selected,
    onShowTimeline: () => {
      setSelection([selected]);
      setResultsSize("normal"); setTimelineRequest(current => current + 1);
    },
  };
  const diagnostics = validation.report?.diagnostics ?? [];
  const runDiagnostics = ownRun ? mergeDiagnostics(run.job?.diagnostics ?? [], problemDiagnostics(run.problem)) : [];
  const launchIsCurrent = ownRun && launchDocuments !== null && loaded !== null &&
    documentValuesEqual(loaded.model, launchDocuments.model) && documentValuesEqual(loaded.experiment, launchDocuments.experiment);
  const currentRunDiagnostics = mergeDiagnostics(ownRun && !staleResults ? run.job?.diagnostics ?? [] : [],
    launchIsCurrent ? problemDiagnostics(run.problem) : []);
  const workspaceDiagnostics = problemDiagnostics(workspace.problem);
  const allDiagnostics = mergeDiagnostics(diagnostics, problemDiagnostics(validation.problem), currentRunDiagnostics, workspaceDiagnostics);
  const path = loaded?.experimentPath ?? null;
  const previousErrors = observedErrors.path === path ? observedErrors : { validation: "[]", run: "[]" };
  const validationResponse = validation.report?.diagnostics ?? (validation.problem === null ? null : problemDiagnostics(validation.problem));
  const validationErrors = validationResponse === null && workspaceDiagnostics.length === 0 ? previousErrors.validation
    : JSON.stringify(mergeDiagnostics(validationResponse ?? [], workspaceDiagnostics).filter((finding) => finding.severity === "ERROR").map(diagnosticKey));
  const waitingForSubmission = ownRun && run.running && run.problem === null &&
    (run.job === null || (run.job.status !== "QUEUED" && run.job.status !== "RUNNING"));
  const runErrors = waitingForSubmission ? previousErrors.run
    : JSON.stringify(runDiagnostics.filter((finding) => finding.severity === "ERROR").map(diagnosticKey));
  if (observedErrors.path !== path || observedErrors.validation !== validationErrors || observedErrors.run !== runErrors) {
    const previousValidation = new Set<string>(JSON.parse(previousErrors.validation));
    const previousRun = new Set<string>(JSON.parse(previousErrors.run));
    const currentRun = new Set(currentRunDiagnostics.map(diagnosticKey));
    const hasNewError = JSON.parse(validationErrors).some((key: string) => !previousValidation.has(key)) ||
      JSON.parse(runErrors).some((key: string) => currentRun.has(key) && !previousRun.has(key));
    setObservedErrors({ path, validation: validationErrors, run: runErrors });
    if (hasNewError) {
      setProblemsElement(null);
      setProblemsRequest((current) => current + 1);
      if (resultsSize === "collapsed") setResultsSize("normal");
    }
  }
  const elementDiagnostics = new Map<string, Diagnostic[]>();
  const fieldDiagnostics = new Map<string, Diagnostic[]>();
  const variantElementDiagnostics = new Map<string, Diagnostic[]>();
  const variantFieldDiagnostics = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (loaded === null) break;
    const target = diagnosticTarget(diagnostic, loaded);
    if (variantId === null && target.variant !== null) {
      const finding = { ...diagnostic, variant: target.variant };
      if (target.element !== null) {
        variantElementDiagnostics.set(target.element, [...(variantElementDiagnostics.get(target.element) ?? []), finding]);
      }
      if (target.element === selected && target.field !== null) {
        variantFieldDiagnostics.set(target.field, [...(variantFieldDiagnostics.get(target.field) ?? []), finding]);
      }
    }
    const variantMatches = target.variant === null || target.variant === variant?.id;
    if (!target.field?.startsWith("grid") && !variantMatches) continue;
    if (variantMatches && target.element !== null) {
      elementDiagnostics.set(target.element, [...(elementDiagnostics.get(target.element) ?? []), diagnostic]);
    }
    const setting = target.field?.startsWith("execution") || target.field?.startsWith("faults") || target.field?.startsWith("grid");
    if (target.field !== null && (setting || target.element === selected)) {
      fieldDiagnostics.set(target.field, [...(fieldDiagnostics.get(target.field) ?? []), diagnostic]);
    }
  }
  const runBlockedReason = loaded !== null && !hasClient ? t("app.canvas.addClient")
    : validation.pending ? t("app.validation.pending")
    : validation.problem !== null ? t("app.validation.failed")
      : validation.report?.valid === false ? t("app.validation.invalid") : undefined;

  const onValidity = useCallback((key: string, valid: boolean) => {
    setInvalidFields((current) => {
      if (valid === !current.has(key)) return current;
      const next = new Set(current);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (invalid || loading || event.defaultPrevented || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      const key = event.key.toLowerCase();
      if (structureEditable && loaded !== null) {
        if ((key === "delete" || key === "backspace") && selection.length > 0) {
          event.preventDefault();
          execute(deleteElements(selection));
          setSelection([]);
        }
        if ((event.ctrlKey || event.metaKey) && key === "c") {
          const fragment = copySelection(loaded, selection);
          if (Object.keys(fragment.blocks).length > 0) {
            event.preventDefault();
            clipboard.current = { path: loaded.experimentPath, fragment, offset: 0 };
          }
        }
        if ((event.ctrlKey || event.metaKey) && key === "v" && clipboard.current?.path === loaded.experimentPath) {
          event.preventDefault();
          const { gridStep, snapToGrid } = currentViewSettings();
          clipboard.current.offset += 2 * gridStep;
          const command = pasteSelection(clipboard.current.fragment, clipboard.current.offset, gridStep, snapToGrid);
          const pasted = command(loaded);
          const before = new Set([...Object.keys(loaded.model.blocks), ...loaded.model.connections.map((edge) => edge.id)]);
          execute(command);
          setInspectorTarget("element");
          setSelection([...Object.keys(pasted.model.blocks), ...pasted.model.connections.map((edge) => edge.id)]
            .filter((id) => !before.has(id)));
        }
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [invalid, loading, undo, redo, structureEditable, loaded, selection, execute]);

  useEffect(() => {
    if (!analysis) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setAnalysis(false);
      }
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [analysis]);

  const openFault = (index: number) => {
    if (invalid || loading) return;
    setAnalysis(false);
    setSelection([]);
    setInspectorTarget("experiment");
    setFieldFocus(previous => ({ path: `faults.${index}.target`, request: (previous?.request ?? 0) + 1 }));
    setFaultRequest(current => current + 1);
  };
  const courseModel = model === null || catalog === null ? null : applyOverrides(model,
    ownRun && !staleResults ? run.summary?.variants.find(candidate => candidate.id === variantId)?.points.find(point => point.id === selectedPointId)?.coordinates ?? {} : {}, catalog);
  const courseFaults = loaded === null || courseModel === null || catalog === null ? [] : courseData(courseModel, loaded.experiment, catalog).faults;
  const courseTime = ownRun && !staleResults && variant !== undefined && seriesMetadata != null;

  const requestEstimate = () => {
    if (resultsSize === "collapsed") setResultsSize("normal");
    setEstimatePanel({ source: "manual" });
    return estimate.request();
  };

  const resetExperimentView = () => {
    setEstimatePanel(null);
    setProblemsElement(null);
    setResultsSize("collapsed");
    setAnalysis(false);
    setSelection([]);
    setInspectorTarget("experiment");
    setFieldFocus(null);
    clipboard.current = null;
    selectVariant(null);
    run.reset();
  };

  return (
    <div className={`app app--results-${resultsSize}`}>
      <TopBar
        models={workspace.models}
        model={workspace.selectedModel}
        onModel={path => {
          if (invalid || loading || workspace.saving || run.running || runPending || estimate.pending) return;
          if (workspace.dirty && !window.confirm(t("app.confirm.discardChanges"))) return;
          resetExperimentView();
          void workspace.openModel(path, true);
        }}
        experiments={workspace.experiments}
        experiment={loaded?.experimentPath ?? null}
        onExperiment={(path) => {
          if (invalid || workspace.loading || workspace.saving || run.running || estimate.pending) return;
          if (workspace.dirty && !window.confirm(t("app.confirm.discardChanges"))) return;
          resetExperimentView();
          void workspace.open(path, true);
        }}
        onInspectExperiment={() => {
          if (invalid || loading) return;
          setAnalysis(false);
          setSelection([]); setInspectorTarget("experiment"); setFieldFocus(null);
        }}
        loading={workspace.loading}
        dirty={workspace.dirty}
        savePending={loaded?.versions.experiment === null}
        invalid={invalid}
        conflict={workspace.conflict}
        saving={workspace.saving}
        onSave={() => void workspace.save()}
        fileMenu={<FileMenu workspace={workspace}
          disabled={invalid || loading || workspace.saving || run.running || runPending || estimate.pending}
          onOpened={resetExperimentView} />}
        canUndo={workspace.canUndo}
        canRedo={workspace.canRedo}
        onUndo={workspace.undo}
        onRedo={workspace.redo}
        running={run.running || runPending}
        runBlockedReason={runBlockedReason}
        estimating={estimate.pending}
        onEstimate={() => void requestEstimate()}
        canResume={ownRun && run.manifest?.complete === false && (run.job?.status === "CANCELLED" || run.job?.status === "FAILED")}
        onResume={() => {
          if (loaded === null) return;
          setLaunchDocuments({ model: loaded.model, experiment: loaded.experiment });
          if (resultsSize === "collapsed") setResultsSize("normal");
          void run.resume();
        }}
        onRun={() => {
          if (loaded === null) return;
          if (resultsSize === "collapsed") setResultsSize("normal");
          setRunPending(true);
          setEstimatePanel(null);
          void estimate.request().then(async (cost) => {
            if (cost === null) return;
            if (cost.problem !== null || cost.value.warnings.some(warning =>
              warning.code === "ESTIMATE_UI_CACHE" || warning.code === "ESTIMATE_EXTRAPOLATION")) {
              setEstimatePanel({ source: "run", previousJobId: run.job?.id ?? null });
            }
            if (cost.problem !== null) {
              if (!window.confirm(t("app.confirm.estimateFailed", { message: backendMessage(cost.problem) }))) return;
            } else {
              const budgets = cost.value.warnings.filter((warning) => warning.code === "ESTIMATE_UI_CACHE");
              if (budgets.length > 0 && !window.confirm(t("app.confirm.startRun", { warnings: budgets.map((warning) => backendMessage(warning)).join("\n") }))) return;
            }
            const documents = { model: loaded.model, experiment: loaded.experiment };
            if (loaded.versions.experiment === null && !await workspace.save()) return;
            setLaunchDocuments(documents);
            await run.run(loaded.experimentPath, documents);
          }).finally(() => setRunPending(false));
        }}
        onCancel={() => {
          if (loaded !== null) setLaunchDocuments({ model: loaded.model, experiment: loaded.experiment });
          void run.cancel();
        }}
        job={ownRun ? run.job : null}
        estimatePanel={showEstimate && (estimate.pending || estimate.estimate !== null || estimate.problem !== null) ? (
          <EstimatePopover onClose={() => setEstimatePanel(null)}>
            {estimate.pending ? <p className="banner" role="status">{t("app.estimate.pending")}</p> : null}
            {estimate.estimate === null ? null : <CostEstimate estimate={estimate.estimate} />}
            {estimate.problem === null ? null : <ProblemList problem={estimate.problem} />}
          </EstimatePopover>
        ) : null}
      />
      <ResultsWorkspace canvasFooterHeight={loaded === null || catalog === null ? 0 : 32} inspectorRequest={faultRequest} view={resultsView} collapsed={resultsSize === "collapsed"} analysis={analysis}
        inspectorSelection={target === "element" ? selected : null}
        inspector={model === null || loaded === null || catalog === null ? (
          <aside hidden={analysis} className="inspector" aria-label={t("app.canvas.inspector")} />
        ) : (
          <Inspector
            resultsOnly={analysis}
            variantChanges={variant === undefined ? undefined : <VariantChanges model={loaded.model} catalog={catalog}
              overrides={overrides} disabled={invalid || loading} onSelect={selectVariantChange} />}
            results={elementResults === null ? null : <ElementResults {...elementResults} />}
            resultsFirst={elementResults !== null && elementResults.manifest.complete && projectElementResults(elementResults) !== null}
            key={JSON.stringify([loaded.experimentPath, variant?.id ?? null])}
            catalog={catalog}
            model={model}
            experiment={loaded.experiment}
            selected={selected}
            target={target}
            focusField={fieldFocus}
            editable={editable}
            variantId={variant?.id ?? null}
            invalid={invalid}
            onCommand={workspace.execute}
            overrides={overrides}
            onRename={(id, next) => {
              workspace.execute(renameElement(id, next));
            }}
            onParam={workspace.setParam}
            onValidity={onValidity}
            fieldDiagnostics={fieldDiagnostics}
            variantFieldDiagnostics={variantId === null ? variantFieldDiagnostics : undefined}
            onVariantDiagnostic={(id, path) => {
              if (invalid || loading) return;
              selectVariant(id);
              setFieldFocus(previous => ({ path, request: (previous?.request ?? 0) + 1 }));
            }}
          />
        )}>
      <Palette hidden={analysis} catalog={catalog} editable={editable && !invalid} onAdd={(type) => canvas.current?.addBlock(type)} />
      <main className="canvas-area" onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented && event.target instanceof Element &&
          !event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
          event.preventDefault();
          if (analysis) setAnalysis(false);
          else playback.seek(null);
        }
      }}>
        <div className="canvas-messages">
          {invalid ? (
            <div className="banner" role="alert">
              {t("app.fields.invalid")}
            </div>
          ) : null}
          {workspace.externalChange !== null || workspace.conflict ? (
            <div className="banner" role="alert">
              {workspace.externalChange?.deleted ? (
                <>{t("app.documents.deletedBeforePath")}<code>{workspace.externalChange.path}</code>{t("app.documents.afterPath")}</>
              ) : (
                <>
                  {t("app.documents.changedBeforePath")}<code>{workspace.externalChange?.path ?? workspace.conflictPath}</code>{t("app.documents.changedAfterPath")}
                  {workspace.externalChange !== null && workspace.dirty ? t("app.documents.discardWarning") : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (workspace.externalChange !== null && workspace.dirty &&
                        !window.confirm(t("app.confirm.reloadChanges"))) return;
                      setSelection([]);
                      setInspectorTarget("experiment");
                      setFieldFocus(null);
                      clipboard.current = null;
                      void workspace.reload();
                    }}
                  >
                    {t("app.documents.reload")}
                  </button>
                </>
              )}
            </div>
          ) : null}
          {workspace.problem === null ? null : <ProblemList problem={workspace.problem} />}
          {!ownRun || run.summary === null || variant === undefined || catalog === null || model === null ? null : <ResultsContextBar
            catalog={catalog} model={model} summary={run.summary} variant={variant} selection={results.selection} onSelect={results.select}
            replications={run.manifest?.replications ?? run.summary.variants.find(candidate => candidate.id === variant.id)?.replications ?? 0}
            playback={playback} windowCount={windowCount} windowMs={windowMs} endMs={endMs}
            metric={nodeMetric} onMetricChange={setNodeMetric} connectionMetric={connectionMetric}
            onConnectionMetricChange={setConnectionMetric} stale={staleResults}
            analysis={analysis} onAnalysisChange={() => { setAnalysis(current => !current); setResultsSize("normal"); }} />}
        </div>
        <div className="canvas" onDoubleClick={event => {
          if (invalid || !(event.target instanceof Element)) return;
          const parameter = event.target.closest<HTMLElement>("[data-param-path]");
          const id = parameter?.dataset.elementId, path = parameter?.dataset.paramPath;
          if (id === undefined || path === undefined) return;
          setSelection([id]); setInspectorTarget("element");
          setFieldFocus(previous => ({ path, request: (previous?.request ?? 0) + 1, focus: false }));
        }}>
          {model === null || loaded === null || catalog === null ? (
            <p className="canvas-empty">{t("app.canvas.loading")}</p>
          ) : (
            <Canvas
              ref={canvas}
              model={model}
              baseModel={loaded.model}
              variant={variant}
              onSelectChange={selectVariantChange}
              onModelPage={() => { if (!invalid) { setAnalysis(false); selectVariant(null); setFieldFocus(null); } }}
              layout={loaded.layout}
              key={loaded.experimentPath}
              catalog={catalog}
              selected={selection}
              faults={courseFaults} onFault={openFault} bottomInset={courseHeight}
              elementDiagnostics={elementDiagnostics}
              variantElementDiagnostics={variantElementDiagnostics}
              onProblems={id => {
                if (invalid || loading) return;
                setSelection([id]); setInspectorTarget("element"); setFieldFocus(null);
                setProblemsElement(id); setProblemsRequest(current => current + 1); setResultsSize("normal");
              }}
              onZoomChange={setCanvasZoom}
              overrides={overrides}
              results={showDiagramResults ? diagramResults : null}
              nodeMetric={nodeMetric === "off" ? "utilization" : nodeMetric}
              connectionMetric={connectionMetric}
              editable={structureEditable && !invalid}
              parametersEditable={editable}
              disabled={invalid}
              onCommand={(command) => {
                const next = command(loaded);
                workspace.execute(command);
                const added = Object.keys(next.model.blocks).filter((id) => !Object.hasOwn(loaded.model.blocks, id));
                if (added.length > 0) { setSelection(added); setInspectorTarget("element"); setFieldFocus(null); }
              }}
              onParam={(id, path, value) => {
                if (variant === undefined) workspace.setParam(id, path, value);
                else workspace.execute(setVariantParam(variant.id, id, path, value ?? null, catalog));
              }}
              onValidity={(key, valid) => onValidity(`canvas:${key}`, valid)}
              onSelect={(next) => {
                if (!invalid) { setSelection(next); setInspectorTarget("element"); setFieldFocus(null); }
              }}
            />
          )}
          {loaded !== null && !hasClient ? <p className="canvas-empty canvas-client-hint">{t("app.canvas.addClient")}</p> : null}
        </div>
        {courseModel === null || loaded === null || catalog === null ? null : <ExperimentCourse
          model={courseModel} experiment={loaded.experiment} catalog={catalog} onFault={openFault} onHeightChange={setCourseHeight} disabled={invalid || loading}
          cursorWindow={courseTime ? results.selection.window : null} windowMs={windowMs}
          onCursorChange={courseTime ? playback.seek : undefined} />}
        <VariantTabs variants={variants} active={variant?.id ?? null} disabled={invalid || !editable} onCommand={workspace.execute}
          onSelect={id => {
            if (id === variantId) {
              setAnalysis(false);
              setSelection([]);
              setInspectorTarget(id === null ? "experiment" : "variant");
            }
            setFieldFocus(null);
            selectVariant(id);
          }}
          onInspect={(id, focusLabel) => {
            setAnalysis(false);
            selectVariant(id); setSelection([]); setInspectorTarget("variant");
            setFieldFocus(previous => focusLabel ? { path: "variant.label", request: (previous?.request ?? 0) + 1 } : null);
          }} />
      </main>
      <ResultsPanel
        running={runPending || (ownRun && run.running)}
        job={ownRun ? run.job : null}
        summary={ownRun ? run.summary : null}
        problem={launchIsCurrent ? run.problem : null}
        catalog={catalog}
        model={ownRun ? run.documents?.model ?? null : null}
        manifest={ownRun ? run.manifest : null}
        stale={staleResults}
        activeVariantId={variant?.id ?? null}
        selectedPointId={results.selection.pointId}
        onPointChange={(pointId) => results.select({ pointId })}
        runId={ownRun ? run.job?.runId ?? null : null}
        experiment={ownRun ? run.documents?.experiment ?? null : null}
        selectedNodes={selection}
        replication={results.selection.replication}
        cursorWindow={results.selection.window}
        onCursorChange={playback.seek}
        size={resultsSize}
        onSizeChange={setResultsSize}
        onViewChange={setResultsView}
        diagnostics={allDiagnostics}
        diagnosticDocuments={loaded}
        problemsRequest={problemsRequest}
        problemsElement={problemsElement}
        onClearProblemsElement={() => setProblemsElement(null)}
        timelineRequest={timelineRequest}
        validationPending={validation.pending}
        validationProblem={validation.problem}
        onElement={id => {
          if (loaded === null || run.documents === null || invalid || loading) return;
          const previous = elementOf(run.documents.model, id);
          if (previous === null) return;
          const elements = [...Object.entries(loaded.model.blocks), ...loaded.model.connections.map(edge => [edge.id, edge] as const)];
          const current = elements.find(([, element]) => elementIdentity(element) === elementIdentity(previous));
          if (current !== undefined) { setSelection([current[0]]); setInspectorTarget("element"); setFieldFocus(null); }
        }}
        onDiagnostic={(diagnostic) => {
          if (loaded === null || invalid || loading) return;
          setAnalysis(false);
          const target = diagnosticTarget(diagnostic, loaded);
          selectVariant(target.variant);
          const setting = target.field?.startsWith("execution") || target.field?.startsWith("faults") || target.field?.startsWith("grid");
          setSelection(setting || target.element === null ? [] : [target.element]);
          setInspectorTarget(setting ? "experiment" : target.element !== null ? "element" : target.variant !== null ? "variant" : "experiment");
          setFieldFocus(previous => target.field === null ? null : { path: target.field, request: (previous?.request ?? 0) + 1 });
        }}
      />
      </ResultsWorkspace>
      <StatusBar job={ownRun ? run.job : null} health={health.health} healthError={health.error}
        diagnostics={allDiagnostics} stale={staleResults} zoom={model === null ? null : canvasZoom}
        cursorMs={ownRun && seriesMetadata != null && results.selection.window !== null ? results.selection.window * windowMs : null}
        onProblems={() => {
          setProblemsElement(null);
          setProblemsRequest((current) => current + 1);
          if (resultsSize === "collapsed") setResultsSize("normal");
        }} />
    </div>
  );
}
