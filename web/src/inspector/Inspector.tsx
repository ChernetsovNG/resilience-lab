import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n";
import type { Catalog, Diagnostic, ExperimentFile, ModelFile } from "../api/apiTypes";
import type { EditorCommand } from "../workspace/editor";
import { resetVariantParam, setVariantParam } from "../workspace/experimentCommands";
import { elementOf, isOverridden } from "../workspace/params";
import { IdentifierField } from "./IdentifierField";
import { ParamField } from "./ParamField";
import { RunSettings } from "./RunSettings";
import { VariantSettings } from "./VariantSettings";
import { InspectorSection } from "./InspectorSection";

export interface InspectorProps {
  catalog: Catalog;
  results?: ReactNode;
  variantChanges?: ReactNode;
  /** Prioritize available results; without them, parameters default to open unless a preference was saved. */
  resultsFirst?: boolean;
  resultsOnly?: boolean;
  hidden?: boolean;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  experiment: ExperimentFile;
  selected: string | null;
  /** Session-only target; defaults to the selected element or the experiment. */
  target?: "element" | "variant" | "experiment";
  focusField?: { path: string; request: number; focus?: boolean } | null;
  /** False while a workspace is loading. */
  editable: boolean;
  variantId?: string | null;
  invalid?: boolean;
  onCommand?: (command: EditorCommand) => void;
  overrides: Record<string, unknown>;
  onRename?: (id: string, next: string) => void;
  onParam: (id: string, name: string, value: unknown) => void;
  /** Validity of a field draft by `elementId.path`; a field that unmounts reports itself valid. */
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  variantFieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onVariantDiagnostic?: (variant: string, field: string) => void;
}

/** Context inspector (product vision §5.5): one selected element, variant identity or shared experiment settings. */
export function Inspector({ catalog, model, experiment, selected, editable, overrides, onRename, onParam, onValidity,
  hidden = false, variantId = null, invalid = false, onCommand, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic,
  target = selected === null ? "experiment" : "element", focusField, results, variantChanges, resultsFirst = false, resultsOnly = false }: InspectorProps) {
  const panel = useRef<HTMLElement>(null);
  const prioritizeResults = resultsFirst && variantId !== null && target === "element" && results != null;
  useEffect(() => {
    if (hidden || focusField == null) return;
    const field = [...(panel.current?.querySelectorAll<HTMLElement>("[data-inspector-field]") ?? [])]
      .find(element => element.dataset.inspectorField === focusField.path);
    const section = field?.closest<HTMLDetailsElement>(".inspector-section");
    if (section !== null && section !== undefined) section.open = true;
    if (focusField.focus !== false) field?.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)")?.focus();
  }, [focusField, hidden, target, selected, variantId]);
  const element = selected === null ? null : elementOf(model, selected);
  const type = element === null ? undefined : catalog.types.find((candidate) => candidate.id === element.type);

  return (
    <aside ref={panel} hidden={hidden} className="inspector" aria-label={t("editor.inspector.label")}>
      {resultsOnly ? <>
        {selected === null ? <p>{t("results.element.select")}</p> : <h2>{selected}</h2>}
      </> : null}
      <div hidden={resultsOnly}>
      {target === "variant" && onCommand !== undefined ? (
        <><VariantSettings variants={experiment.variants} active={variantId} disabled={!editable || invalid} editable={editable}
          onCommand={onCommand} onValidity={onValidity} fieldDiagnostics={fieldDiagnostics} />
          {variantChanges}</>
      ) : null}
      {target === "element" && selected !== null && element !== null && type !== undefined ? (
        <>
          <h2>{selected}</h2>
          <p className="inspector-type">
            {type.title}
            {variantId === null ? "" : t("editor.inspector.variantOverrides")}
          </p>
          {prioritizeResults && !resultsOnly ? results : null}
          <InspectorSection name="parameters" title={t("editor.inspector.parameters")} defaultOpen={!prioritizeResults}>
          {onRename === undefined ? null : (
            <IdentifierField key={selected} model={model} identifier={selected} editable={editable && variantId === null}
              onRename={onRename} onValidity={onValidity} />
          )}
          {type.params.length === 0 ? <p>{t("editor.inspector.noParameters")}</p> : null}
          {type.params.map((descriptor) => (
            <ParamField
              key={`${selected}.${descriptor.name}`}
              descriptor={descriptor}
              value={element.params[descriptor.name]}
              path={descriptor.name}
              editable={editable}
              isOverridden={(path) => isOverridden(overrides, selected, path)}
              onCommit={(value) => onParam(selected, descriptor.name, value)}
              onFieldCommit={variantId === null ? undefined : (path, value) => onCommand?.(setVariantParam(variantId, selected, path, value ?? null, catalog))}
              onReset={variantId === null ? undefined : (path) => {
                onCommand?.(resetVariantParam(variantId, selected, path, catalog));
                const field = [...(panel.current?.querySelectorAll<HTMLElement>("[data-inspector-field]") ?? [])]
                  .find(element => element.dataset.inspectorField === path);
                requestAnimationFrame(() => field?.querySelector<HTMLElement>("input, select")?.focus());
              }}
              onValidity={(path, valid) => onValidity(`${selected}.${path}`, valid)}
              fieldDiagnostics={fieldDiagnostics}
              variantFieldDiagnostics={variantId === null ? variantFieldDiagnostics : undefined}
              onVariantDiagnostic={onVariantDiagnostic}
              navigationDisabled={invalid}
            />
          ))}
          </InspectorSection>
        </>
      ) : null}
      {target === "experiment" ? <section className="experiment-settings">
        <RunSettings catalog={catalog} model={model} experiment={experiment} editable={editable && onCommand !== undefined}
          invalid={invalid} fieldDiagnostics={fieldDiagnostics} onCommand={(command) => onCommand?.(command)} onValidity={onValidity} />
      </section> : null}
      </div>
      {variantId !== null && (resultsOnly || (target === "element" && !prioritizeResults)) ? results : null}
    </aside>
  );
}
