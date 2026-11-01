import { useId } from "react";
import type { Diagnostic, ModelFile } from "../api/apiTypes";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import { isObject } from "../workspace/params";

/** Structural request type selection; omitted filters apply to every request type. */
export function RequestTypeFilter({ model, value, label, path, editable, invalid, readOnlyHint, fieldDiagnostics, onChange }: {
  model: ModelFile; value?: readonly string[] | null; label: string; path: string;
  editable: boolean; invalid: boolean; readOnlyHint?: string;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onChange: (classes: string[]) => void;
}) {
  const id = useId();
  const clients = Object.values(model.blocks).filter(block => block.type === "client");
  const selected = value ?? [];
  const declared = clients.flatMap(client => Array.isArray(client.params.classes)
    ? client.params.classes.flatMap(type => isObject(type) && typeof type.id === "string" ? [type.id] : []) : ["default"]);
  const choices = [...new Set([...declared, ...selected])];
  const diagnostics = [...(fieldDiagnostics ?? [])].filter(([field]) => field === path || field.startsWith(`${path}.`))
    .flatMap(([, findings]) => findings);
  if (!clients.some(client => Array.isArray(client.params.classes)) && selected.length === 0) return null;
  const errors = diagnostics.some(finding => finding.severity === "ERROR");
  return <fieldset className="param-group request-type-filter" aria-label={label} data-inspector-field={path}
    title={readOnlyHint} aria-invalid={errors || undefined} aria-describedby={diagnostics.length ? id : undefined}>
    <legend>{label} <HelpHint label={label}>{t("editor.requestTypeFilter.help")}</HelpHint></legend>
    {selected.length === 0 ? <span className="inspector-type">{t("editor.requestTypeFilter.all")}</span> : null}
    <div className="request-type-options">{choices.map(type => <label key={type}
      data-inspector-field={selected.includes(type) ? `${path}.${selected.indexOf(type)}` : undefined}>
      <input type="checkbox" checked={selected.includes(type)} disabled={!editable || invalid} onChange={event => {
        if (editable && !invalid) onChange(event.target.checked ? [...selected, type] : selected.filter(id => id !== type));
      }} />{type}
    </label>)}</div>
    <DiagnosticMessages diagnostics={diagnostics} id={id} />
  </fieldset>;
}
