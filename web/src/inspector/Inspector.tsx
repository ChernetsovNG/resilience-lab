import { t } from "../i18n";
import type { Catalog, Diagnostic, ExperimentFile, ModelFile } from "../api/apiTypes";
import type { EditorCommand } from "../workspace/editor";
import { resetVariantParam, setVariantParam } from "../workspace/experimentCommands";
import { elementOf, isOverridden } from "../workspace/params";
import { IdentifierField } from "./IdentifierField";
import { ParamField } from "./ParamField";
import { RunSettings } from "./RunSettings";
import { VariantSettings } from "./VariantSettings";

export interface InspectorProps {
  catalog: Catalog;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  experiment: ExperimentFile;
  selected: string | null;
  /** False while a workspace is loading. */
  editable: boolean;
  variantId?: string | null;
  invalid?: boolean;
  onCommand?: (command: EditorCommand) => void;
  onVariantSelect?: (id: string | null) => void;
  overrides: Record<string, unknown>;
  onRename?: (id: string, next: string) => void;
  onParam: (id: string, name: string, value: unknown) => void;
  /** Validity of a field draft by `elementId.path`; a field that unmounts reports itself valid. */
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

/** Context inspector (product vision §5.5): catalog fields, variant controls and shared experiment settings. */
export function Inspector({ catalog, model, experiment, selected, editable, overrides, onRename, onParam, onValidity,
  variantId = null, invalid = false, onCommand, onVariantSelect, fieldDiagnostics }: InspectorProps) {
  const element = selected === null ? null : elementOf(model, selected);
  const type = element === null ? undefined : catalog.types.find((candidate) => candidate.id === element.type);

  return (
    <aside className="inspector" aria-label={t("editor.inspector.label")}>
      {onCommand === undefined || onVariantSelect === undefined ? null : (
        <VariantSettings variants={experiment.variants} active={variantId} disabled={!editable || invalid} editable={editable}
          onCommand={onCommand} onSelect={onVariantSelect} onValidity={onValidity} />
      )}
      {selected !== null && element !== null && type !== undefined ? (
        <>
          <h2>{selected}</h2>
          <p className="inspector-type">
            {type.title}
            {variantId === null ? "" : t("editor.inspector.variantOverrides")}
          </p>
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
              onReset={variantId === null ? undefined : (path) => onCommand?.(resetVariantParam(variantId, selected, path, catalog))}
              onValidity={(path, valid) => onValidity(`${selected}.${path}`, valid)}
              fieldDiagnostics={fieldDiagnostics}
            />
          ))}
        </>
      ) : null}
      <details className="experiment-settings" open={selected === null}>
        <summary>{t("editor.inspector.experimentSettings")}</summary>
        <RunSettings catalog={catalog} model={model} experiment={experiment} editable={editable && onCommand !== undefined}
          invalid={invalid} fieldDiagnostics={fieldDiagnostics} onCommand={(command) => onCommand?.(command)} onValidity={onValidity} />
      </details>
    </aside>
  );
}
