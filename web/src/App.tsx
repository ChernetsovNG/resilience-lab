import { useBeforeUnload } from "./components/useBeforeUnload";
import { ExperimentCourse } from "./experiment/ExperimentCourse";
import { courseData } from "./experiment/course";
import { backendMessage } from "./i18n/backendMessage";
import { CostEstimate } from "./run/CostEstimate";
import { useEstimate } from "./run/useEstimate";

import { canvasResults, type ConnectionOverlayMetric, type NodeOverlayMetric } from "./results/canvasResults";
import { ResultsContextBar } from "./results/ResultsContextBar";
import { EstimatePopover } from "./run/EstimatePopover";
import { usePlayback } from "./results/playback/usePlayback";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { t } from "./i18n";
import type { Diagnostic, ModelFile, Variant } from "./api/apiTypes";
import { diagnosticKey, diagnosticTarget, mergeDiagnostics, problemDiagnostics } from "./validation/diagnostics";
import { useValidation } from "./validation/useValidation";
import { Canvas, type CanvasHandle } from "./canvas/Canvas";
import { ModelInfo } from "./canvas/ModelInfo";
import { VariantTabs } from "./canvas/VariantTabs";
import { VariantChanges } from "./canvas/VariantChanges";
import { useHealth } from "./components/useHealth";
import { useConfirmation } from "./components/useConfirmation";
import { DiagnosticLabelContext } from "./presentation/diagnosticContext";
import { parameterLabel, variantLabel } from "./presentation/labels";
import { ElementResults, type ElementResultsProps } from "./inspector/ElementResults";
import { replicaMember } from "./results/groups";
import { hasElementResults, resultSelection } from "./inspector/elementResultsData";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./layout/Palette";
import { ProblemList } from "./layout/ProblemList";
import { ResultsWorkspace } from "./layout/ResultsWorkspace";
import { ResultsPanel, type ResultsPanelSize, type ResultsPanelView } from "./layout/ResultsPanel";
import { TopBar } from "./layout/TopBar";
import { FileMenu, type FileMenuHandle } from "./layout/FileMenu";
import { StatusBar } from "./layout/StatusBar";
import { currentViewSettings } from "./layout/viewSettings";
import { runDocumentsEqual, useRun, type RunDocuments } from "./run/useRun";
import { useResultsSelection } from "./results/selection";
import { setVariantParam } from "./workspace/experimentCommands";
import { documentValuesEqual, elementIdentity, setModelParam } from "./workspace/editor";
import { applyOverrides, elementOf } from "./workspace/params";
import { copySelection, deleteElements, pasteSelection, renameElement, type ClipboardFragment } from "./workspace/structure";
import { useWorkspace } from "./workspace/useWorkspace";

/**
 * One-screen layout (product vision §5.5, stage 1 design §6.1). The model page edits the model; a variant page edits the
 * variant's parameter overrides. Run settings and faults belong to the shared experiment. Results are shown
 * only for the experiment they were computed for.
 */
export function App() {
  const health = useHealth();
  const workspace = useWorkspace(health.reportFailure, health.reportSuccess);
  const { confirm, confirmDocumentSwitch, confirmationDialog } = useConfirmation();
  const canvas = useRef<CanvasHandle>(null);
  const fileMenu = useRef<FileMenuHandle>(null);
  const run = useRun();
  const [runPending, setRunPending] = useState(false);
  const runInFlight = useRef(false);
  const [command, setCommand] = useState<"save" | "run" | null>(null);
  const startingRun = runPending || command === "run";
  const summary = run.result?.summary ?? null;
  const resultDocuments = run.result?.documents ?? run.documents;
  const resultManifest = run.result?.manifest ?? run.manifest;
  const resultRunId = run.result?.runId ?? run.job?.runId ?? null;
  /** Selection follows variant identity across list edits and its ID across rename/undo/redo; null shows the model. */
  const [variantPage, setVariantPage] = useState<{ id: string | null; variants: Variant[] }>({ id: null, variants: [] });
  const results = useResultsSelection(run.result?.jobId ?? run.result?.runId ?? null);
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
  const [observedErrors, setObservedErrors] = useState<{ path: string | null; run: string; estimate: string }>({ path: null, run: "[]", estimate: "[]" });
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionModel, setSelectionModel] = useState<ModelFile | null>(null);
  const [courseHeight, setCourseHeight] = useState(0);
  const [inspectorRequest, setInspectorRequest] = useState(0);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorTarget, setInspectorTarget] = useState<"element" | "variant" | "experiment">("experiment");
  const [fieldFocus, setFieldFocus] = useState<{ path: string; request: number; focus?: boolean } | null>(null);
  const clipboard = useRef<{ path: string; fragment: ClipboardFragment; offset: number } | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const { loaded, catalog, loading, undo, redo, execute } = workspace;
  const experimentPath = loaded?.experimentPath ?? null;
  const runExperiment = run.experiment;
  const restoreRun = useEffectEvent((path: string) => loaded === null ? Promise.resolve(false) : run.restore(path, loaded.model));
  useEffect(() => {
    if (!loading && experimentPath !== null && runExperiment !== experimentPath) void restoreRun(experimentPath);
  }, [experimentPath, runExperiment, loading]);
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
  useBeforeUnload(workspace.dirty || invalid);
  const setModelParameter = async (id: string, name: string, value: unknown) => {
    if (loaded === null || catalog === null) return;
    const command = setModelParam(id, name, value, catalog);
    const next = command(loaded);
    const removed = [
      ...(loaded.experiment.grid ?? []).flatMap((axis, index) => next.experiment.grid?.some(candidate => candidate.path === axis.path) ? []
        : [t("app.confirm.removedAxis", { number: index + 1, parameter: parameterLabel(axis.path, catalog, loaded.model) })]),
      ...loaded.experiment.variants.flatMap((variant, index) => Object.keys(variant.overrides)
        .filter(path => !Object.hasOwn(next.experiment.variants[index].overrides, path))
        .map(path => t("app.confirm.removedOverride", { variant: variantLabel(variant, variants), parameter: parameterLabel(path, catalog, loaded.model) }))),
    ];
    if (removed.length > 0 && !await confirm({
      title: t("app.confirm.removeDependentSettings"),
      message: t("app.confirm.dependentSettingsMessage", { settings: removed.join("\n") }),
      confirmLabel: t("app.confirm.changeAction"), cancelLabel: t("file.cancel"),
    })) return;
    workspace.execute(command);
  };
  const selectVariantChange = (id: string, path: string) => {
    if (invalid || loading) return;
    setAnalysis(false);
    setSelection([id]); setInspectorTarget("element");
    setInspectorRequest(current => current + 1);
    setFieldFocus(previous => ({ path, request: (previous?.request ?? 0) + 1 }));
  };
  const ownRun = loaded !== null && run.experiment === loaded.experimentPath;
  const staleResults = ownRun && loaded !== null && resultDocuments !== null && !runDocumentsEqual(loaded, resultDocuments);
  const selectedPointId = results.selection.pointId;
  const summaryDiagramResults = ownRun && summary !== null && resultDocuments !== null && variant !== undefined && catalog !== null
    ? canvasResults(summary, resultDocuments.model, variant.id, selectedPointId, catalog, loaded.model, resultDocuments.experiment) : null;
  const seriesMetadata = ownRun ? resultManifest?.series : null;
  const endMs = (seriesMetadata?.warmupMs ?? 0) + (seriesMetadata?.measurementMs ?? 0);
  const windowMs = seriesMetadata?.windowMs ?? 1;
  const windowCount = Math.ceil(endMs / windowMs);
  const playback = usePlayback({
    runId: resultRunId ?? "", variant: showDiagramResults ? variant?.id ?? null : null,
    pointId: selectedPointId, replication: results.selection.replication, window: results.selection.window,
    windowCount, nodes: ownRun && resultDocuments !== null ? Object.keys(resultDocuments.model.blocks) : [],
    results: summaryDiagramResults, onWindowChange: (window) => results.select({ window }),
  });
  const diagramResults = results.selection.window === null ? summaryDiagramResults : playback.frame;
  const resultVariantId = variantId ?? summary?.variants[0]?.id;
  const resultPoint = summary?.variants.find(candidate => candidate.id === resultVariantId)?.points.find(point => point.id === selectedPointId);
  const resultGroups = resultPoint?.aggregate.groups ?? [];
  const member = results.selection.replicaId == null ? null : replicaMember(resultGroups, results.selection.replicaId);
  const selectedReplica = member?.group.id === selected && resultDocuments !== null && loaded !== null
    && resultSelection(resultDocuments.model, loaded.model, member.instance.id, resultGroups) !== null ? member.instance : null;
  const replicaModel = selectedReplica === null || resultDocuments === null || catalog === null ? undefined : applyOverrides(
    applyOverrides(resultDocuments.model, resultDocuments.experiment.variants.find(variant => variant.id === resultVariantId)?.overrides ?? {}, catalog),
    resultPoint?.coordinates ?? {}, catalog);
  const selectResultElement = (id: string) => {
    if (loaded === null || resultDocuments === null || invalid || loading) return;
    const replica = replicaMember(resultGroups, id);
    const previous = elementOf(resultDocuments.model, replica?.group.id ?? id);
    if (previous === null) return;
    const elements = [...Object.entries(loaded.model.blocks), ...loaded.model.connections.map(edge => [edge.id, edge] as const)];
    const current = elements.find(([, element]) => elementIdentity(element) === elementIdentity(previous));
    if (current === undefined) return;
    if (variantId === null && resultVariantId !== undefined) selectVariant(resultVariantId);
    setSelection([current[0]]); setInspectorTarget("element"); setFieldFocus(null);
    results.select({ replicaId: replica?.instance.id ?? null });
    setInspectorRequest(current => current + 1);
  };
  const elementResults: ElementResultsProps | null = selected === null || !ownRun || resultRunId === null || summary === null || resultManifest === null || resultDocuments === null || variant === undefined || catalog === null ? null : {
    runId: resultRunId, summary: summary, manifest: resultManifest,
    runModel: resultDocuments.model, currentModel: loaded.model, experiment: resultDocuments.experiment,
    catalog, variantId: variant.id, pointId: selectedPointId, replication: results.selection.replication,
    window: results.selection.window, selected: selectedReplica?.id ?? selected,
    onSelectReplica: selectResultElement,
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
    launchIsCurrent || (ownRun && launchDocuments === null) ? problemDiagnostics(run.problem) : []);
  const workspaceDiagnostics = problemDiagnostics(workspace.problem);
  const allDiagnostics = mergeDiagnostics(diagnostics, problemDiagnostics(validation.problem), currentRunDiagnostics, workspaceDiagnostics, estimate.problem?.diagnostics ?? []);
  const path = loaded?.experimentPath ?? null;
  const previousErrors = observedErrors.path === path ? observedErrors : { run: "[]", estimate: "[]" };
  const waitingForSubmission = ownRun && run.running && run.problem === null &&
    (run.job === null || (run.job.status !== "QUEUED" && run.job.status !== "RUNNING"));
  const runErrors = waitingForSubmission ? previousErrors.run
    : JSON.stringify(runDiagnostics.filter((finding) => finding.severity === "ERROR").map(diagnosticKey));
  const estimateErrors = estimate.pending ? previousErrors.estimate
    : JSON.stringify((estimate.problem?.diagnostics ?? []).filter(finding => finding.severity === "ERROR").map(diagnosticKey));
  if (observedErrors.path !== path || observedErrors.run !== runErrors || observedErrors.estimate !== estimateErrors) {
    const previousRun = new Set<string>(JSON.parse(previousErrors.run));
    const previousEstimate = new Set<string>(JSON.parse(previousErrors.estimate));
    const currentRun = new Set(currentRunDiagnostics.map(diagnosticKey));
    const hasNewError = (launchDocuments !== null && JSON.parse(runErrors).some((key: string) => currentRun.has(key) && !previousRun.has(key))) ||
      JSON.parse(estimateErrors).some((key: string) => !previousEstimate.has(key));
    setObservedErrors({ path, run: runErrors, estimate: estimateErrors });
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
  const validationFailed = validation.problem !== null || validation.report?.valid === false;
  const openProblems = useCallback(() => {
    setProblemsElement(null);
    setProblemsRequest(current => current + 1);
    setResultsSize(current => current === "collapsed" ? "normal" : current);
  }, []);

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
      if (event.defaultPrevented || event.altKey) return;
      const target = event.target;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === "s" || key === "enter") &&
        !(target instanceof Element && target.closest("textarea, [contenteditable]:not([contenteditable='false']), dialog, [role='dialog']"))) {
        event.preventDefault();
        if (!event.repeat) {
          if (target instanceof HTMLInputElement) target.blur();
          setCommand(key === "s" ? "save" : "run");
        }
        return;
      }
      if (invalid || loading) return;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
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
    setInspectorRequest(current => current + 1);
  };
  const courseModel = model === null || catalog === null ? null : applyOverrides(model,
    ownRun && !staleResults ? summary?.variants.find(candidate => candidate.id === variantId)?.points.find(point => point.id === selectedPointId)?.coordinates ?? {} : {}, catalog);
  const courseFaults = loaded === null || courseModel === null || catalog === null ? [] : courseData(courseModel, loaded.experiment, catalog).faults;
  const courseTime = ownRun && !staleResults && variant !== undefined && seriesMetadata != null;

  const requestEstimate = async () => {
    if (validationFailed) { openProblems(); return; }
    if (resultsSize === "collapsed") setResultsSize("normal");
    setEstimatePanel({ source: "manual" });
    const cost = await estimate.request();
    if (cost?.problem?.diagnostics.some(finding => finding.severity === "ERROR")) setEstimatePanel(null);
  };

  const resetExperimentView = () => {
    setCommand(null);
    setLaunchDocuments(null);
    setEstimatePanel(null);
    setProblemsElement(null);
    setAnalysis(false);
    setSelection([]);
    setInspectorTarget("experiment");
    setFieldFocus(null);
    clipboard.current = null;
    selectVariant(null);
    run.reset();
  };

  const startRun = useCallback(async () => {
    if (loaded === null || invalid || loading || workspace.saving || workspace.conflict || run.running ||
      runInFlight.current || estimate.pending || health.error !== null) return;
    if (runBlockedReason !== undefined) {
      if (hasClient && validationFailed) openProblems();
      return;
    }
    runInFlight.current = true;
    if (resultsSize === "collapsed") setResultsSize("normal");
    setRunPending(true);
    setEstimatePanel(null);
    try {
      const cost = await estimate.request();
      if (cost === null) return;
      if (cost.problem?.diagnostics.some(finding => finding.severity === "ERROR")) return;
      if (cost.problem !== null || cost.value.warnings.some(warning =>
        warning.code === "ESTIMATE_UI_CACHE" || warning.code === "ESTIMATE_EXTRAPOLATION")) {
        setEstimatePanel({ source: "run", previousJobId: run.job?.id ?? null });
      }
      if (cost.problem !== null) {
        if (!await confirm({ title: t("app.confirm.runTitle"),
          message: t("app.confirm.estimateFailed", { message: backendMessage(cost.problem) }),
          confirmLabel: t("app.confirm.runAction"), cancelLabel: t("app.confirm.reviewEstimateAction") })) return;
      } else {
        const budgets = cost.value.warnings.filter(warning => warning.code === "ESTIMATE_UI_CACHE");
        if (budgets.length > 0 && !await confirm({ title: t("app.confirm.runTitle"),
          message: t("app.confirm.startRun", { warnings: budgets.map(warning => backendMessage(warning)).join("\n") }),
          confirmLabel: t("app.confirm.runAction"), cancelLabel: t("app.confirm.reviewEstimateAction") })) return;
      }
      const documents = { model: loaded.model, experiment: loaded.experiment };
      if ((workspace.dirty || loaded.versions.experiment === null) && !await workspace.save()) return;
      setLaunchDocuments(documents);
      await run.run(loaded.experimentPath, documents);
    } finally {
      runInFlight.current = false;
      setRunPending(false);
    }
  }, [loaded, invalid, loading, workspace, run, estimate, runBlockedReason, health.error, resultsSize, confirm, hasClient, validationFailed, openProblems]);

  useEffect(() => {
    if (command === null) return;
    // A field commits on blur/Enter; its new snapshot must pass validation before keyboard Run.
    if (command === "run" && validation.pending && !invalid && !loading && !runInFlight.current) return;
    const timer = window.setTimeout(() => {
      setCommand(null);
      if (command === "run") void startRun();
      else if (!invalid && !loading && !workspace.saving && !workspace.conflict && health.error === null) void workspace.save();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [command, validation.pending, invalid, loading, startRun, workspace, health.error]);

  return (
    <DiagnosticLabelContext value={{ variants: loaded?.experiment.variants ?? [], grid: loaded?.experiment.grid ?? [], catalog, model }}>
    <div className={`app app--results-${resultsSize}`}>
      <TopBar
        models={workspace.models}
        model={workspace.selectedModel}
        onNewModel={() => { void fileMenu.current?.start("new"); }}
        onNewExperiment={() => { void fileMenu.current?.start("newExperiment"); }}
        onModel={async path => {
          if (invalid || loading || workspace.saving || run.running || startingRun || estimate.pending) return;
          if (workspace.dirty && !await confirmDocumentSwitch(workspace.save)) return;
          resetExperimentView();
          void workspace.openModel(path, true);
        }}
        experiments={workspace.experiments}
        experiment={loaded?.experimentPath ?? null}
        onExperiment={async (path) => {
          if (invalid || workspace.loading || workspace.saving || run.running || startingRun || estimate.pending) return;
          if (workspace.dirty && !await confirmDocumentSwitch(workspace.save)) return;
          resetExperimentView();
          void workspace.open(path, true);
        }}
        onInspectExperiment={() => {
          if (invalid || loading) return;
          setAnalysis(false);
          setSelection([]); setInspectorTarget("experiment");
          setInspectorRequest(current => current + 1);
          setFieldFocus(previous => ({ path: "execution", request: (previous?.request ?? 0) + 1, focus: false }));
        }}
        runSettingsPressed={loaded !== null && target === "experiment" && !analysis && !inspectorCollapsed}
        loading={workspace.loading}
        dirty={workspace.dirty}
        savePending={loaded?.versions.experiment === null}
        invalid={invalid}
        conflict={workspace.conflict}
        saving={workspace.saving}
        backendError={health.error === null ? undefined : t("app.health.unavailable", { error: health.error })}
        onSave={() => void workspace.save()}
        fileMenu={<FileMenu ref={fileMenu} workspace={workspace}
          disabled={invalid || loading || workspace.saving || run.running || startingRun || estimate.pending}
          onOpened={resetExperimentView} />}
        canUndo={workspace.canUndo}
        canRedo={workspace.canRedo}
        onUndo={workspace.undo}
        onRedo={workspace.redo}
        running={run.running || startingRun}
        runBlockedReason={runBlockedReason}
        onValidationProblems={hasClient && validationFailed ? openProblems : undefined}
        runProblem={workspace.problem === null ? undefined : backendMessage(workspace.problem)}
        estimating={estimate.pending}
        onEstimate={() => void requestEstimate()}
        canResume={ownRun && run.canResume}
        onResume={() => {
          if (loaded === null) return;
          setLaunchDocuments({ model: loaded.model, experiment: loaded.experiment });
          if (resultsSize === "collapsed") setResultsSize("normal");
          void run.resume();
        }}
        onRun={() => {
          if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
          setCommand("run");
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
      <ResultsWorkspace canvasFooterHeight={loaded === null || catalog === null ? 0 : 32} inspectorRequest={inspectorRequest}
        onInspectorCollapsedChange={setInspectorCollapsed} view={resultsView} collapsed={resultsSize === "collapsed"} analysis={analysis}
        inspectorSelection={target === "element" ? selected : null}
        inspector={model === null || loaded === null || catalog === null ? (
          <aside hidden={analysis} className="inspector" aria-label={t("app.canvas.inspector")} />
        ) : (
          <Inspector
            resultsOnly={analysis}
            variantChanges={variant === undefined ? undefined : <VariantChanges model={loaded.model} catalog={catalog}
              overrides={overrides} disabled={invalid || loading} onSelect={selectVariantChange} />}
            results={elementResults === null ? null : <ElementResults {...elementResults} />}
            resultsFirst={launchDocuments !== null && elementResults !== null && elementResults.manifest.complete && hasElementResults(elementResults)}
            key={JSON.stringify([loaded.experimentPath, variant?.id ?? null])}
            catalog={catalog}
            model={model}
            experiment={loaded.experiment}
            experimentPath={loaded.experimentPath}
            selected={selected}
            renameReferences={selected === null ? undefined : workspace.experimentsUsing(selected)}
            requestTypeReferences={workspace.requestTypeExperimentsUsing}
            selectedReplica={selectedReplica}
            replicaModel={replicaModel}
            target={target}
            focusField={fieldFocus}
            editable={editable}
            variantId={variant?.id ?? null}
            invalid={invalid}
            onCommand={workspace.execute}
            onOpenFault={openFault}
            overrides={overrides}
            onRename={(id, next) => {
              workspace.execute(renameElement(id, next));
            }}
            onParam={setModelParameter}
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
      <Palette hidden={analysis} catalog={catalog} editable={model !== null && structureEditable && !invalid} onAdd={(type) => canvas.current?.addBlock(type)} />
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
                    onClick={async () => {
                      if (workspace.externalChange !== null && workspace.dirty &&
                        !await confirm({ title: t("app.confirm.reloadChanges"),
                          confirmLabel: t("app.confirm.reloadAction"), cancelLabel: t("app.confirm.stayAction") })) return;
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
          {!ownRun || summary === null || variant === undefined || catalog === null || model === null ? null : <ResultsContextBar
            catalog={catalog} model={model} summary={summary} variant={variant} selection={results.selection} onSelect={results.select}
            replications={resultManifest?.replications ?? summary.variants.find(candidate => candidate.id === variant.id)?.replications ?? 0}
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
            <p className="canvas-empty">{t(catalog !== null && !workspace.loading && workspace.models.length === 0 ? "file.emptyWorkspace" : "app.canvas.loading")}</p>
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
              modelInfo={<ModelInfo key={loaded.modelPath} modelPath={loaded.modelPath} model={loaded.model} experiment={loaded.experiment}
                notesDisabled={invalid || loading} onFullNotes={() => {
                  setAnalysis(false);
                  setSelection([]); setInspectorTarget("experiment");
                  setInspectorRequest(current => current + 1);
                  setFieldFocus(previous => ({ path: "model.notes", request: (previous?.request ?? 0) + 1 }));
                }} />}
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
              replicaSelection={selectedReplica === null || selected === null ? null : { groupId: selected, replica: selectedReplica.replica }}
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
                if (variant === undefined) void setModelParameter(id, path, value);
                else workspace.execute(setVariantParam(variant.id, id, path, value ?? null, catalog));
              }}
              onValidity={(key, valid) => onValidity(`canvas:${key}`, valid)}
              onSelect={(next) => {
                if (!invalid) { setSelection(next); setInspectorTarget("element"); setFieldFocus(null); results.select({ replicaId: null }); }
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
        running={startingRun || (ownRun && run.running)}
        job={ownRun ? run.job : null}
        summary={ownRun ? summary : null}
        problem={launchIsCurrent || (ownRun && launchDocuments === null) ? run.problem : null}
        catalog={catalog}
        model={ownRun ? resultDocuments?.model ?? null : null}
        manifest={ownRun ? resultManifest : null}
        stale={staleResults}
        activeVariantId={variant?.id ?? null}
        selectedPointId={results.selection.pointId}
        onPointChange={(pointId) => results.select({ pointId })}
        runId={ownRun ? resultRunId : null}
        experiment={ownRun ? resultDocuments?.experiment ?? null : null}
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
        onElement={selectResultElement}
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
      {confirmationDialog}
      <StatusBar job={ownRun ? run.job : null} health={health.health} healthError={health.error}
        diagnostics={allDiagnostics} stale={staleResults} zoom={model === null ? null : canvasZoom}
        cursorMs={ownRun && seriesMetadata != null && results.selection.window !== null ? results.selection.window * windowMs : null}
        onProblems={openProblems} />
    </div>
    </DiagnosticLabelContext>
  );
}
