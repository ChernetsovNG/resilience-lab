import { useCallback, useEffect, useRef, useState } from "react";
import type { Diagnostic, Variant } from "./api/apiTypes";
import { diagnosticTarget } from "./validation/diagnostics";
import { useValidation } from "./validation/useValidation";
import { Canvas } from "./canvas/Canvas";
import { VariantTabs } from "./canvas/VariantTabs";
import { useHealth } from "./components/useHealth";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./layout/Palette";
import { ProblemList } from "./layout/ProblemList";
import { ResultsPanel } from "./layout/ResultsPanel";
import { TopBar } from "./layout/TopBar";
import { useRun } from "./run/useRun";
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
  const [pointSelection, setPointSelection] = useState<{ summary: typeof run.summary; id: string }>({ summary: null, id: "p0" });
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.at(-1) ?? null;
  const clipboard = useRef<{ path: string; fragment: ClipboardFragment; offset: number } | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const { loaded, catalog, loading, undo, redo, execute } = workspace;
  const validation = useValidation(loaded);
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
  const diagnostics = validation.report?.diagnostics ?? [];
  const elementDiagnostics = new Map<string, Diagnostic[]>();
  const fieldDiagnostics = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (loaded === null) break;
    const target = diagnosticTarget(diagnostic, loaded);
    if (target.variant !== null && target.variant !== variant?.id) continue;
    if (target.element !== null) {
      elementDiagnostics.set(target.element, [...(elementDiagnostics.get(target.element) ?? []), diagnostic]);
    }
    const setting = target.field?.startsWith("execution") || target.field?.startsWith("faults");
    if (target.field !== null && (setting || target.element === selected)) {
      fieldDiagnostics.set(target.field, [...(fieldDiagnostics.get(target.field) ?? []), diagnostic]);
    }
  }
  const runBlockedReason = validation.pending ? "Wait for validation to finish"
    : validation.problem !== null ? "Validation failed; edit or reload the documents to retry"
      : validation.report?.valid === false ? "Fix validation errors before running" : undefined;

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

  return (
    <div className="app">
      <TopBar
        experiments={workspace.experiments}
        experiment={loaded?.experimentPath ?? null}
        onExperiment={(path) => {
          if (invalid || workspace.loading || workspace.saving || run.running) return;
          if (workspace.dirty && !window.confirm("Discard unsaved changes to the documents?")) return;
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
        onRun={() => {
          if (loaded !== null) void run.run(loaded.experimentPath, { model: loaded.model, experiment: loaded.experiment });
        }}
        onCancel={() => void run.cancel()}
        job={ownRun ? run.job : null}
        health={health.health}
        healthError={health.error}
      />
      <Palette catalog={catalog} editable={structureEditable && !invalid} />
      <main className="canvas-area">
        <div className="canvas-messages">
          {invalid ? (
            <div className="banner" role="alert">
              Fix invalid values before changing the selected element, page or experiment.
            </div>
          ) : null}
          {workspace.externalChange !== null || workspace.conflict ? (
            <div className="banner" role="alert">
              {workspace.externalChange?.deleted ? (
                <>The document was deleted on disk: <code>{workspace.externalChange.path}</code>.</>
              ) : (
                <>
                  The document changed on disk: <code>{workspace.externalChange?.path ?? workspace.conflictPath}</code>.{" "}
                  {workspace.externalChange !== null && workspace.dirty ? "Reload will discard unsaved changes. " : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (workspace.externalChange !== null && workspace.dirty &&
                        !window.confirm("Reload and discard unsaved changes to the documents?")) return;
                      setSelection([]);
                      clipboard.current = null;
                      void workspace.reload();
                    }}
                  >
                    Reload
                  </button>
                </>
              )}
            </div>
          ) : null}
          {workspace.problem === null ? null : <ProblemList problem={workspace.problem} />}
        </div>
        <div className="canvas">
          {model === null || loaded === null || catalog === null ? (
            <p className="canvas-empty">Loading workspace…</p>
          ) : (
            <Canvas
              model={model}
              layout={loaded.layout}
              key={loaded.experimentPath}
              catalog={catalog}
              selected={selection}
              elementDiagnostics={elementDiagnostics}
              overrides={overrides}
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
        <aside className="inspector" aria-label="Inspector" />
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
        selectedPointId={pointSelection.summary === run.summary ? pointSelection.id : "p0"}
        onPointChange={(id) => setPointSelection({ summary: run.summary, id })}
        diagnostics={diagnostics}
        validationPending={validation.pending}
        validationProblem={validation.problem}
        onDiagnostic={(diagnostic) => {
          if (loaded === null || invalid || loading) return;
          const target = diagnosticTarget(diagnostic, loaded);
          selectVariant(target.variant);
          const setting = target.field?.startsWith("execution") || target.field?.startsWith("faults");
          setSelection(setting || target.element === null ? [] : [target.element]);
        }}
      />
    </div>
  );
}
