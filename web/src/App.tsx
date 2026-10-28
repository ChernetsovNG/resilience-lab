import { useCallback, useState } from "react";
import { Canvas } from "./canvas/Canvas";
import { VariantTabs } from "./canvas/VariantTabs";
import { useHealth } from "./components/useHealth";
import { Inspector } from "./inspector/Inspector";
import { Palette } from "./layout/Palette";
import { ProblemList } from "./layout/ProblemList";
import { ResultsPanel } from "./layout/ResultsPanel";
import { TopBar } from "./layout/TopBar";
import { useRun } from "./run/useRun";
import { applyOverrides } from "./workspace/params";
import { useWorkspace } from "./workspace/useWorkspace";

/**
 * One-screen layout (product vision §5.5, stage 1 design §6.1). The model page edits the model; a variant page shows the
 * model with the variant's overrides, read-only in the stage 1 slice even when the variant has none. Results are shown
 * only for the experiment they were computed for.
 */
export function App() {
  const workspace = useWorkspace();
  const run = useRun();
  const health = useHealth();
  /** Active variant page; null, or an ID the open experiment lacks, shows the model page. */
  const [variantId, setVariantId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const { loaded, catalog } = workspace;
  const variants = loaded?.experiment.variants ?? [];
  const variant = variants.find((candidate) => candidate.id === variantId);
  const overrides = variant?.overrides ?? {};
  const editable = variant === undefined && !workspace.loading;
  const model = loaded === null || catalog === null ? null : applyOverrides(loaded.model, overrides, catalog);
  const invalid = invalidFields.size > 0;
  const ownRun = loaded !== null && run.experiment === loaded.experimentPath;

  const onValidity = useCallback((key: string, valid: boolean) => {
    setInvalidFields((current) => {
      if (valid === !current.has(key)) return current;
      const next = new Set(current);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="app">
      <TopBar
        experiments={workspace.experiments}
        experiment={loaded?.experimentPath ?? null}
        onExperiment={(path) => {
          if (invalid || workspace.loading || workspace.saving || run.running) return;
          if (workspace.dirty && !window.confirm("Discard unsaved changes to the model?")) return;
          setSelected(null);
          setVariantId(null);
          run.reset();
          void workspace.open(path, true);
        }}
        loading={workspace.loading}
        dirty={workspace.dirty}
        invalid={invalid}
        conflict={workspace.conflict}
        saving={workspace.saving}
        onSave={() => void workspace.save()}
        running={run.running}
        onRun={() => {
          if (loaded !== null) void run.run(loaded.experimentPath);
        }}
        job={ownRun ? run.job : null}
        health={health.health}
        healthError={health.error}
      />
      <Palette catalog={catalog} />
      <main className="canvas-area">
        <div className="canvas-messages">
          {invalid ? (
            <div className="banner" role="alert">
              Fix invalid values before changing the selected element, page or experiment.
            </div>
          ) : null}
          {workspace.conflict ? (
            <div className="banner" role="alert">
              The model changed on disk.{" "}
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  void workspace.reload();
                }}
              >
                Reload
              </button>
            </div>
          ) : null}
          {workspace.problem === null ? null : <ProblemList problem={workspace.problem} />}
        </div>
        <div className="canvas">
          {model === null || loaded === null ? (
            <p className="canvas-empty">Loading workspace…</p>
          ) : (
            <Canvas
              model={model}
              layout={loaded.layout}
              selected={selected}
              onSelect={(id) => {
                if (!invalid) setSelected(id);
              }}
            />
          )}
        </div>
        <VariantTabs variants={variants} active={variant?.id ?? null} disabled={invalid} onSelect={setVariantId} />
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
          overrides={overrides}
          onParam={workspace.setParam}
          onValidity={onValidity}
        />
      )}
      <ResultsPanel
        job={ownRun ? run.job : null}
        summary={ownRun ? run.summary : null}
        problem={ownRun ? run.problem : null}
      />
    </div>
  );
}
