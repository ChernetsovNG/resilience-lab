import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import type { Variant } from "../api/apiTypes";
import type { EditorCommand } from "../workspace/editor";
import { addVariant, nextVariantId, removeVariant, updateVariant, variantIdError } from "../workspace/experimentCommands";

interface Props {
  variants: Variant[];
  active: string | null;
  disabled: boolean;
  editable: boolean;
  onCommand: (command: EditorCommand) => void;
  onSelect: (id: string | null) => void;
  onValidity: (key: string, valid: boolean) => void;
}

/** Variant identity and creation controls; selection remains outside document history. */
export function VariantSettings({ variants, active, disabled, editable, onCommand, onSelect, onValidity }: Props) {
  const variant = variants.find((candidate) => candidate.id === active);
  const add = (copy: boolean) => {
    const id = nextVariantId(variants);
    onCommand(addVariant(id, copy && variant !== undefined ? t("editor.variant.copyLabel", { label: variant.label ?? variant.id }) : t("editor.variant.newLabel", { number: id.slice(8) }), copy ? variant?.id : undefined));
    onSelect(id);
  };
  return (
    <section className="variant-settings" aria-label={t("editor.variant.label")}>
      <div className="inspector-actions">
        <button type="button" disabled={disabled} onClick={() => add(false)}>{t("editor.variant.add")}</button>
        <button type="button" disabled={disabled || variant === undefined} onClick={() => add(true)}>{t("editor.variant.copy")}</button>
      </div>
      {variant === undefined ? null : (
        <>
          <VariantText key={`${variant.id}-id`} label={t("editor.variant.id")} value={variant.id} editable={editable}
            error={(id) => variantIdError(variants, id, variant.id)} onValidity={onValidity}
            onCommit={(id) => { if (!disabled) onCommand(updateVariant(variant.id, { id })); }} />
          <VariantText key={`${variant.id}-label`} label={t("editor.variant.name")} value={variant.label ?? ""} editable={editable}
            onValidity={onValidity} onCommit={(label) => onCommand(updateVariant(variant.id, { label }))} />
          <button type="button" disabled={disabled || variants.length <= 1} onClick={() => {
            if (window.confirm(t("editor.variant.deleteConfirm", { label: variant.label ?? variant.id }))) {
              onCommand(removeVariant(variant.id));
              onSelect(null);
            }
          }}>{t("editor.variant.delete")}</button>
        </>
      )}
    </section>
  );
}

function VariantText({ label, value, editable, error, onCommit, onValidity }: {
  label: string;
  value: string;
  editable: boolean;
  error?: (value: string) => string | null;
  onCommit: (value: string) => void;
  onValidity: Props["onValidity"];
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
    <div className="param-field">
      <label>{label}<input type="text" value={draft} readOnly={!editable} aria-invalid={message === null ? undefined : true}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }} /></label>
      {message === null ? null : <span className="param-error" role="alert">{message}</span>}
    </div>
  );
}
