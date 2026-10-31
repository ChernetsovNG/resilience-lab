import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnnotationFields } from "./AnnotationFields";
import { setAnnotation } from "../workspace/annotations";
import { t } from "../i18n";
import { ReplicaOverrides } from "./ReplicaOverrides";
import { TypeHelp } from "../help/TypeHelp";
import type { Catalog, Diagnostic, ExperimentFile, ModelFile } from "../api/apiTypes";
import type { EditorCommand } from "../workspace/editor";
import { addFault, resetVariantParam, setVariantParam } from "../workspace/experimentCommands";
import { createFault, faultTargets, type FaultTarget } from "../workspace/faults";
import { elementOf, isOverridden, ownEntry } from "../workspace/params";
import { IdentifierField } from "./IdentifierField";
import { ParamField } from "./ParamField";
import { RunSettings } from "./RunSettings";
import { VariantSettings } from "./VariantSettings";
import { InspectorSection } from "./InspectorSection";
import { ServiceScenario } from "./ServiceScenario";
import { LoadProfile } from "./LoadProfile";
import { ReplicaTargetField } from "./ReplicaTargetField";
import { variantLabel } from "../presentation/labels";

export interface InspectorProps {
  catalog: Catalog;
  results?: ReactNode;
  variantChanges?: ReactNode;
  /** Prioritize available results; without them, parameters default to open unless a preference was saved. */
  resultsFirst?: boolean;
  resultsOnly?: boolean;
  selectedReplica?: { id: string; replica: number } | null;
  replicaModel?: ModelFile;
  hidden?: boolean;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  experiment: ExperimentFile;
  experimentPath?: string;
  selected: string | null;
  /** Session-only target; defaults to the selected element or the experiment. */
  target?: "element" | "variant" | "experiment";
  focusField?: { path: string; request: number; focus?: boolean } | null;
  /** False while a workspace is loading. */
  editable: boolean;
  variantId?: string | null;
  invalid?: boolean;
  onCommand?: (command: EditorCommand) => void;
  /** Reveal the newly appended shared fault in run settings. */
  onOpenFault?: (index: number) => void;
  overrides: Record<string, unknown>;
  onRename?: (id: string, next: string) => void;
  onParam: (id: string, name: string, value: unknown) => void;
  /** Validity of a field draft by `elementId.path`; a field that unmounts reports itself valid. */
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  variantFieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onVariantDiagnostic?: (variant: string, field: string) => void;
}

function AddFaultAction({ model, catalog, elementId, initialTarget = elementId, editable, disabled, onValidity, onAdd }: {
  model: ModelFile; catalog: Catalog; elementId: string; initialTarget?: string; editable: boolean; disabled: boolean;
  onValidity: (path: string, valid: boolean) => void; onAdd: (target: FaultTarget) => void;
}) {
  const [selected, setSelected] = useState(initialTarget);
  const targets = faultTargets(model, catalog, [selected]).filter(target => target.elementId === elementId);
  const target = targets.find(target => target.id === selected);
  return <div className="param-field">
    {targets.length > 1 ? <label>{t("editor.fault.creationTarget")}
      <select aria-label={t("editor.fault.creationTarget")} value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}>
        {target === undefined ? <option value={selected} disabled>{selected}</option> : null}
        {targets.map(target => <option key={target.id} value={target.id}>{target.id}</option>)}
      </select>
    </label> : null}
    <ReplicaTargetField target={targets[0]} value={selected} path="new-fault.replica" editable={editable} onTarget={setSelected} onValidity={onValidity} />
    <button type="button" disabled={disabled || target === undefined} onClick={() => { if (target !== undefined) onAdd(target); }}>{t("editor.fault.add")}</button>
  </div>;
}

/** Context inspector (product vision §5.5): one selected element, variant identity or shared experiment settings. */
export function Inspector({ catalog, model, experiment, experimentPath, selected, editable, overrides, onRename, onParam, onValidity,
  hidden = false, variantId = null, invalid = false, onCommand, onOpenFault, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic,
  target = selected === null ? "experiment" : "element", focusField, results, variantChanges, resultsFirst = false, resultsOnly = false, selectedReplica, replicaModel }: InspectorProps) {
  const panel = useRef<HTMLElement>(null);
  const prioritizeResults = resultsFirst && variantId !== null && target === "element" && results != null;
  useEffect(() => {
    if (hidden || focusField == null) return;
    const fields = [...(panel.current?.querySelectorAll<HTMLElement>("[data-inspector-field]") ?? [])];
    // A malformed step can have diagnostics for controls hidden by its current type.
    const step = focusField.path.startsWith("scenario.") ? focusField.path.split(".").slice(0, 2).join(".") : null;
    const field = fields.find(element => element.dataset.inspectorField === focusField.path)
      ?? (step === null ? undefined : fields.find(element => element.dataset.inspectorField === step))
      ?? fields.find(element => focusField.path.startsWith("replicaOverrides.")
        && element.dataset.inspectorField === focusField.path.split(".").slice(0, 2).join("."));
    const section = field?.closest<HTMLDetailsElement>(".inspector-section");
    if (section !== null && section !== undefined) section.open = true;
    if (focusField.focus !== false) (field?.querySelector<HTMLElement>("input, select, textarea") ?? field?.querySelector<HTMLElement>("button:not(:disabled):not(.help-hint-button)"))?.focus();
  }, [focusField, hidden, target, selected, variantId]);
  const element = selected === null ? null : elementOf(model, selected);
  const targets = faultTargets(model, catalog).filter(target => target.elementId === selected);
  const type = element === null ? undefined : catalog.types.find((candidate) => candidate.id === element.type);
  const showElement = (resultsOnly || target === "element") && element !== null;
  const variant = target === "variant" ? experiment.variants.find(candidate => candidate.id === variantId) : undefined;
  const connection = model.connections.find(candidate => candidate.id === selected);
  const destination = connection === undefined ? undefined : ownEntry(model.blocks, connection.to);
  const attempts = element?.params.attempts ?? type?.params.find(param => param.name === "attempts")?.default ?? 1;
  const parameters = type?.params.filter(descriptor =>
    !(element?.type === "client" && descriptor.name === "load") &&
    (descriptor.name !== "balancing" || (destination?.type === "service" && Number(destination.params.replicas ?? 1) > 1)) &&
    (descriptor.name !== "backoff" || Number(attempts) > 1));
  const heading = showElement ? selectedReplica?.id ?? selected : resultsOnly ? null
    : target === "experiment" ? t("editor.run.title") : variant === undefined ? null : variantLabel(variant, experiment.variants);
  const subtitle = showElement ? (type?.title ?? element?.type) + (variantId === null ? "" : t("editor.inspector.variantOverrides"))
    : target === "variant" ? t("editor.variant.type") : experimentPath?.split("/").at(-1)?.replace(/\.experiment\.json$/, "");

  return (
    <aside ref={panel} hidden={hidden} className="inspector" aria-label={t("editor.inspector.label")}>
      {resultsOnly && selected === null ? <p>{t("results.element.select")}</p> : null}
      {heading === null ? null : <>
        <div className="inspector-heading"><h2>{heading}</h2>
          {showElement && element !== null ? <TypeHelp key={element.type} catalog={catalog} typeId={element.type} /> : null}</div>
        {subtitle === undefined ? null : <p className="inspector-type" title={target === "experiment" ? experimentPath : undefined}>{subtitle}</p>}
      </>}
      <div hidden={resultsOnly && selectedReplica == null}>
      {target === "variant" && onCommand !== undefined ? (
        <><VariantSettings variants={experiment.variants} active={variantId} disabled={!editable || invalid} editable={editable}
          onCommand={onCommand} onValidity={onValidity} fieldDiagnostics={fieldDiagnostics} />
          {variantChanges}</>
      ) : null}
      {target === "element" && selected !== null && element !== null ? (
        <>
          {prioritizeResults && !resultsOnly ? results : null}
          {selectedReplica == null ? <InspectorSection name="parameters" title={t("editor.inspector.parameters")} defaultOpen={!prioritizeResults}>
          {onRename === undefined ? null : (
            <IdentifierField key={selected} model={model} identifier={selected} editable={editable && variantId === null}
              onRename={onRename} onValidity={onValidity} />
          )}
          <AnnotationFields key={`annotations-${selected}`} value={ownEntry(model.blocks, selected) ?? connection ?? {}}
            editable={editable && variantId === null && onCommand !== undefined}
            readOnlyHint={variantId === null ? undefined : t("editor.variant.structureHint")}
            onCommit={(field, value) => onCommand?.(setAnnotation({ element: selected }, field, value))} />
          {type === undefined ? <p>{t("help.type.unknown", { type: element.type })}</p> : null}
          {type?.params.length === 0 ? <p>{t("editor.inspector.noParameters")}</p> : null}
          {parameters?.map((descriptor) => (
            <ParamField
              key={`${selected}.${descriptor.name}`}
              descriptor={descriptor.name === "balancing" ? { ...descriptor, default: descriptor.default ?? "roundRobin" } : descriptor}
              value={element.params[descriptor.name]}
              path={descriptor.name}
              editable={editable}
              isOverridden={(path) => isOverridden(overrides, selected, path)}
              isSwept={(path) => variantId !== null && (experiment.grid ?? []).some(axis =>
                axis.path === `${selected}.${path}` || axis.path.startsWith(`${selected}.${path}.`))}
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
          </InspectorSection> : null}
          {element.type === "client" && element.params.classes == null && type?.params.find(param => param.name === "load") !== undefined ? <LoadProfile key={selected}
            catalog={catalog} model={model} experiment={experiment} clientId={selected}
            descriptor={type.params.find(param => param.name === "load")!}
            editable={editable && (variantId === null || onCommand !== undefined)} invalid={invalid}
            overridden={isOverridden(overrides, selected, "load")} onCommit={value => {
              if (variantId === null) onParam(selected, "load", value);
              else onCommand?.(setVariantParam(variantId, selected, "load", value, catalog));
            }}
            onReset={variantId === null ? undefined : () => onCommand?.(resetVariantParam(variantId, selected, "load", catalog))}
            onValidity={onValidity} fieldDiagnostics={fieldDiagnostics}
            variantFieldDiagnostics={variantId === null ? variantFieldDiagnostics : undefined} onVariantDiagnostic={onVariantDiagnostic} /> : null}
          {element.type === "service" ? <ReplicaOverrides replica={selectedReplica?.replica} key={`replicas-${selected}`} catalog={catalog} model={selectedReplica == null ? model : replicaModel ?? model} serviceId={selected}
            editable={selectedReplica == null && editable && variantId === null && onCommand !== undefined} invalid={invalid}
            readOnlyHint={variantId === null ? undefined : t("editor.variant.structureHint")}
            onCommand={command => onCommand?.(command)} onValidity={onValidity} fieldDiagnostics={fieldDiagnostics} /> : null}
          {element.type === "service" && selectedReplica == null ? <ServiceScenario key={selected} catalog={catalog} model={model} serviceId={selected}
            editable={editable && variantId === null && onCommand !== undefined} invalid={invalid}
            readOnlyHint={variantId === null ? undefined : t("editor.variant.structureHint")}
            onCommand={command => onCommand?.(command)} onValidity={onValidity} fieldDiagnostics={fieldDiagnostics} /> : null}
          {targets.length > 0 && onCommand !== undefined ? <AddFaultAction key={`fault-${selectedReplica?.id ?? selected}`} model={model} catalog={catalog}
            elementId={selected} initialTarget={selectedReplica?.id} editable={editable} onValidity={onValidity}
            disabled={!editable || invalid || createFault(catalog, experiment, targets[0]) === null} onAdd={target => {
              const fault = createFault(catalog, experiment, target);
              if (fault === null) return;
              onCommand(addFault(fault));
              onOpenFault?.(experiment.faults.length);
            }} /> : null}
        </>
      ) : null}
      {target === "experiment" ? <section className="experiment-settings">
        <RunSettings catalog={catalog} model={model} experiment={experiment} editable={editable && onCommand !== undefined}
          invalid={invalid} fieldDiagnostics={fieldDiagnostics} onCommand={(command) => onCommand?.(command)} onValidity={onValidity} />
        <InspectorSection name="annotations" title={t("editor.annotations.title")} defaultOpen={false}>
          <fieldset className="annotation-group"><legend>{t("editor.annotations.model")}</legend>
            <AnnotationFields value={model} prefix="model." editable={editable && variantId === null && onCommand !== undefined}
              readOnlyHint={variantId === null ? undefined : t("editor.variant.structureHint")}
              onCommit={(field, value) => onCommand?.(setAnnotation("model", field, value))} />
          </fieldset>
          <fieldset className="annotation-group"><legend>{t("editor.annotations.experiment")}</legend>
            <AnnotationFields value={experiment} prefix="experiment." editable={editable && onCommand !== undefined}
              onCommit={(field, value) => onCommand?.(setAnnotation("experiment", field, value))} />
          </fieldset>
        </InspectorSection>
      </section> : null}
      </div>
      {variantId !== null && (resultsOnly || (target === "element" && !prioritizeResults)) ? results : null}
    </aside>
  );
}
