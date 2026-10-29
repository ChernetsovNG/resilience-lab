import { CostEstimate } from "./run/CostEstimate";
import { useEstimate } from "./run/useEstimate";

import { canvasResults, utilizationColor } from "./results/canvasResults";
import { PlaybackControls } from "./results/playback/PlaybackControls";
import { usePlayback } from "./results/playback/usePlayback";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { formatDuration, formatNumber, formatPercent } from "./i18n/format";
import type { Diagnostic, Variant } from "./api/apiTypes";
import { diagnosticTarget } from "./validation/diagnostics";
import { useValidation } from "./validation/useValidation";
import { Canvas } from "./canvas/Canvas";
import { VariantTabs } from "./canvas/VariantTabs";
import { useHealth } from "./components/useHealth";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./layout/Palette";
import { ProblemList } from "./layout/ProblemList";
import { ResultsPanel, type ResultsPanelSize } from "./layout/ResultsPanel";
import { TopBar } from "./layout/TopBar";
import { useRun } from "./run/useRun";
import { useResultsSelection } from "./results/selection";
import { setVariantParam } from "./workspace/experimentCommands";
import { documentValuesEqual } from "./workspace/editor";
import { applyOverrides } from "./workspace/params";
import { copySelection, deleteElements, pasteSelection, renameElement, type ClipboardFragment } from "./workspace/structure";
import { useWorkspace } from "./workspace/useWorkspace";

/**
 * One-screen layout (product vision §5.5, stage 1 design §6.1). The model page edits the model; a variant page edits the
 * variant's parameter overrides. Run settings and faults belong to the shared experiment. Results are shown
 * only for the experiment they were computed for.
 */
export function App() {
  const workspace = useWorkspace();
  const run = useRun();
  const health = useHealth();
  /** Selection follows variant identity across list edits and its ID across rename/undo/redo; null shows the model. */
  const [variantPage, setVariantPage] = useState<{ id: string | null; variants: Variant[] }>({ id: null, variants: [] });
  const results = useResultsSelection(run.job?.id ?? null);
  const [showDiagramResults, setShowDiagramResults] = useState(true);
  const [showEstimate, setShowEstimate] = useState(false);
  const [resultsSize, setResultsSize] = useState<ResultsPanelSize>("normal");
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.at(-1) ?? null;
  const clipboard = useRef<{ path: string; fragment: ClipboardFragment; offset: number } | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const { loaded, catalog, loading, undo, redo, execute } = workspace;
  const validation = useValidation(loaded);
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
  const variant = variants.find((candidate) => candidate.id === variantId);
  const overrides = variant?.overrides ?? {};
  const editable = !workspace.loading;
  const structureEditable = editable && variant === undefined;
  const model = loaded === null || catalog === null ? null : applyOverrides(loaded.model, overrides, catalog);
  const invalid = invalidFields.size > 0;
  const ownRun = loaded !== null && run.experiment === loaded.experimentPath;
  const staleResults = ownRun && loaded !== null && run.documents !== null && (
    !documentValuesEqual(loaded.model, run.documents.model) || !documentValuesEqual(loaded.experiment, run.documents.experiment)
  );
  const selectedPointId = results.selection.pointId;
  const summaryDiagramResults = ownRun && run.summary !== null && run.documents !== null && variant !== undefined
    ? canvasResults(run.summary, run.documents.model, variant.id, selectedPointId, loaded.model) : null;
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
  const diagramResults = playback.frame ?? summaryDiagramResults;
  const diagnostics = validation.report?.diagnostics ?? [];
  const elementDiagnostics = new Map<string, Diagnostic[]>();
  const fieldDiagnostics = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (loaded === null) break;
    const target = diagnosticTarget(diagnostic, loaded);
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
  const runBlockedReason = validation.pending ? t("app.validation.pending")
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
          clipboard.current.offset += 40;
          const command = pasteSelection(clipboard.current.fragment, clipboard.current.offset);
          const pasted = command(loaded);
          const before = new Set([...Object.keys(loaded.model.blocks), ...loaded.model.connections.map((edge) => edge.id)]);
          execute(command);
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

  const requestEstimate = () => {
    setShowEstimate(true);
    if (resultsSize === "expanded") setResultsSize("normal");
    return estimate.request();
  };

  return (
    <div className={`app app--results-${resultsSize}`}>
      <TopBar
        experiments={workspace.experiments}
        experiment={loaded?.experimentPath ?? null}
        onExperiment={(path) => {
          if (invalid || workspace.loading || workspace.saving || run.running || estimate.pending) return;
          if (workspace.dirty && !window.confirm(t("app.confirm.discardChanges"))) return;
          setSelection([]);
          clipboard.current = null;
          selectVariant(null);
          run.reset();
          void workspace.open(path, true);
        }}
        loading={workspace.loading}
        dirty={workspace.dirty}
        invalid={invalid}
        conflict={workspace.conflict}
        saving={workspace.saving}
        onSave={() => void workspace.save()}
        canUndo={workspace.canUndo}
        canRedo={workspace.canRedo}
        onUndo={workspace.undo}
        onRedo={workspace.redo}
        running={run.running}
        runBlockedReason={runBlockedReason}
        estimating={estimate.pending}
        onEstimate={() => void requestEstimate()}
        canResume={ownRun && run.manifest?.complete === false && (run.job?.status === "CANCELLED" || run.job?.status === "FAILED")}
        onResume={() => {
          if (resultsSize === "collapsed") setResultsSize("normal");
          void run.resume();
        }}
        onRun={() => {
          if (loaded === null) return;
          void requestEstimate().then((cost) => {
            if (cost === null) return;
            if (cost.problem !== null) {
              if (!window.confirm(t("app.confirm.estimateFailed", { message: cost.problem.message }))) return;
            } else {
              const budgets = cost.value.warnings.filter((warning) => warning.code === "ESTIMATE_UI_CACHE");
              if (budgets.length > 0 && !window.confirm(t("app.confirm.startRun", { warnings: budgets.map((warning) => warning.message).join("\n") }))) return;
            }
            void run.run(loaded.experimentPath, { model: loaded.model, experiment: loaded.experiment });
          });
        }}
        onCancel={() => void run.cancel()}
        job={ownRun ? run.job : null}
        health={health.health}
        healthError={health.error}
      />
      {showEstimate && (estimate.pending || estimate.estimate !== null || estimate.problem !== null) ? (
        <section className="estimate-area" aria-label={t("app.estimate.label")}>
          <button type="button" className="estimate-close" onClick={() => setShowEstimate(false)}>{t("app.estimate.close")}</button>
          {estimate.pending ? <p className="banner" role="status">{t("app.estimate.pending")}</p> : null}
          {estimate.estimate === null ? null : <CostEstimate estimate={estimate.estimate} />}
          {estimate.problem === null ? null : <ProblemList problem={estimate.problem} />}
        </section>
      ) : null}
      <Palette catalog={catalog} editable={structureEditable && !invalid} />
      <main className="canvas-area">
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
          {diagramResults === null ? null : (
            <div className="canvas-results-toolbar" role="region" aria-label={t("app.canvas.results")}>
              <label>
                <input type="checkbox" checked={showDiagramResults} onChange={(event) => setShowDiagramResults(event.target.checked)} />
                {t("app.canvas.showResults")}
              </label>
              {showDiagramResults ? <>
                <span data-testid="canvas-result-context">{playback.frame?.window === undefined
                  ? t("app.canvas.summaryContext", { variant: String(variant?.label ?? variant?.id), pointId: selectedPointId })
                  : t("app.canvas.windowContext", { window: formatNumber(playback.frame.window), start: formatNumber(playback.frame.window * windowMs, 1),
                    end: formatDuration(Math.min(endMs, (playback.frame.window + 1) * windowMs)), replication: formatNumber(results.selection.replication),
                    variant: String(variant?.label ?? variant?.id), pointId: selectedPointId })}</span>
                <span className="utilization-legend" aria-label={t("app.canvas.utilizationScale")}>
                  {t("app.canvas.utilizationLegend", { mode: playback.frame === null ? t("app.canvas.utilizationPooled") : t("app.canvas.utilizationWindow"), minimum: formatPercent(0) })}
                  <span className="utilization-scale" aria-hidden="true"
                    style={{ background: `linear-gradient(90deg, ${utilizationColor(0)}, ${utilizationColor(0.5)}, ${utilizationColor(1)})` }} />
                  {formatPercent(1)}
                </span>
                {windowCount > 0 ? <PlaybackControls playback={playback} window={results.selection.window} windowCount={windowCount}
                  replication={results.selection.replication} replications={run.manifest?.replications ?? 0}
                  onReplicationChange={(replication) => results.select({ replication })} /> : null}
                {staleResults ? <span className="canvas-results-stale" role="status">{t("app.canvas.stale")}</span> : null}
              </> : null}
            </div>
          )}
        </div>
        <div className="canvas">
          {model === null || loaded === null || catalog === null ? (
            <p className="canvas-empty">{t("app.canvas.loading")}</p>
          ) : (
            <Canvas
              model={model}
              layout={loaded.layout}
              key={loaded.experimentPath}
              catalog={catalog}
              selected={selection}
              elementDiagnostics={elementDiagnostics}
              overrides={overrides}
              results={showDiagramResults ? diagramResults : null}
              editable={structureEditable && !invalid}
              parametersEditable={editable}
              disabled={invalid}
              onCommand={workspace.execute}
              onParam={(id, path, value) => {
                if (variant === undefined) workspace.setParam(id, path, value);
                else workspace.execute(setVariantParam(variant.id, id, path, value ?? null, catalog));
              }}
              onValidity={(key, valid) => onValidity(`canvas:${key}`, valid)}
              onSelect={(next) => {
                if (!invalid) setSelection(next);
              }}
            />
          )}
        </div>
        <VariantTabs variants={variants} active={variant?.id ?? null} disabled={invalid} onSelect={selectVariant} />
      </main>
      {model === null || loaded === null || catalog === null ? (
        <aside className="inspector" aria-label={t("app.canvas.inspector")} />
      ) : (
        <Inspector
          key={JSON.stringify([loaded.experimentPath, variant?.id ?? null])}
          catalog={catalog}
          model={model}
          experiment={loaded.experiment}
          selected={selected}
          editable={editable}
          variantId={variant?.id ?? null}
          invalid={invalid}
          onCommand={workspace.execute}
          onVariantSelect={selectVariant}
          overrides={overrides}
          onRename={(id, next) => {
            workspace.execute(renameElement(id, next));
            setSelection((current) => current.map((value) => value === id ? next : value));
          }}
          onParam={workspace.setParam}
          onValidity={onValidity}
          fieldDiagnostics={fieldDiagnostics}
        />
      )}
      <ResultsPanel
        job={ownRun ? run.job : null}
        summary={ownRun ? run.summary : null}
        problem={ownRun ? run.problem : null}
        catalog={catalog}
        model={ownRun ? run.documents?.model ?? null : null}
        manifest={ownRun ? run.manifest : null}
        stale={staleResults}
        activeVariantId={variant?.id ?? null}
        selectedPointId={results.selection.pointId}
        onPointChange={(pointId) => results.select({ pointId })}
        runId={ownRun ? run.job?.runId ?? null : null}
        experiment={ownRun ? run.documents?.experiment ?? null : null}
        selectedNodes={selection.filter((id) => loaded !== null && Object.hasOwn(loaded.model.blocks, id))}
        replication={results.selection.replication}
        onReplicationChange={(replication) => results.select({ replication })}
        cursorWindow={results.selection.window}
        onCursorChange={playback.seek}
        size={resultsSize}
        onSizeChange={setResultsSize}
        diagnostics={diagnostics}
        validationPending={validation.pending}
        validationProblem={validation.problem}
        onDiagnostic={(diagnostic) => {
          if (loaded === null || invalid || loading) return;
          const target = diagnosticTarget(diagnostic, loaded);
          selectVariant(target.variant);
          const setting = target.field?.startsWith("execution") || target.field?.startsWith("faults") || target.field?.startsWith("grid");
          setSelection(setting || target.element === null ? [] : [target.element]);
        }}
      />
    </div>
  );
}
