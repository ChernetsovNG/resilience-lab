import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import type { Diagnostic, Variant } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { updateVariant, variantIdError } from "../workspace/experimentCommands";

interface Props {
  variants: Variant[];
  active: string | null;
  disabled: boolean;
  editable: boolean;
  onCommand: (command: EditorCommand) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onValidity: (key: string, valid: boolean) => void;
}

/** Variant identity fields; page selection and tab commands remain outside this form. */
export function VariantSettings({ variants, active, disabled, editable, onCommand, onValidity, fieldDiagnostics }: Props) {
  const variant = variants.find((candidate) => candidate.id === active);
  return variant === undefined ? null : (
    <section className="variant-settings" aria-label={t("editor.variant.label")}>
      <h2>{t("editor.variant.properties")}</h2>
      <VariantText key={`${variant.id}-id`} label={t("editor.variant.id")} path="variant.id" value={variant.id} editable={editable}
        error={(id) => variantIdError(variants, id, variant.id)} onValidity={onValidity} diagnostics={fieldDiagnostics?.get("variant.id")}
        onCommit={(id) => { if (!disabled) onCommand(updateVariant(variant.id, { id })); }} />
      <VariantText key={`${variant.id}-label`} label={t("editor.variant.name")} path="variant.label" value={variant.label ?? ""} editable={editable}
        onValidity={onValidity} diagnostics={fieldDiagnostics?.get("variant.label")}
        onCommit={(label) => onCommand(updateVariant(variant.id, { label }))} />
    </section>
  );
}

function VariantText({ label, path, value, editable, error, onCommit, onValidity, diagnostics }: {
  label: string;
  path: string;
  value: string;
  editable: boolean;
  error?: (value: string) => string | null;
  onCommit: (value: string) => void;
  onValidity: Props["onValidity"];
  diagnostics?: readonly Diagnostic[];
}) {
  const [draft, setDraft] = useState(value);
  const [previous, setPrevious] = useState(value);
  if (previous !== value) { setPrevious(value); setDraft(value); }
  const message = error?.(draft) ?? null;
  const validity = useRef(onValidity);
  useEffect(() => { validity.current = onValidity; }, [onValidity]);
  useEffect(() => { validity.current(label, !editable || draft === value || message === null); }, [label, editable, draft, value, message]);
  useEffect(() => () => { validity.current(label, true); }, [label]);
  const commit = () => { if (editable && message === null && draft !== value) onCommit(draft); };
  return (
    <div className="param-field" data-inspector-field={path}>
      <label>{label}<input type="text" value={draft} readOnly={!editable} aria-invalid={message === null ? undefined : true}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }} /></label>
      <DiagnosticMessages diagnostics={diagnostics} />
      {message === null ? null : <span className="param-error" role="alert">{message}</span>}
    </div>
  );
}
