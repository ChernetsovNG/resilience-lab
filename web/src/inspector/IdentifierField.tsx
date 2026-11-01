import { useBeforeUnload } from "../components/useBeforeUnload";
import { t } from "../i18n";
import { useEffect, useId, useRef, useState } from "react";
import type { ModelFile } from "../api/apiTypes";
import { identifierError } from "../workspace/structure";

interface IdentifierFieldProps {
  model: ModelFile;
  identifier: string;
  editable: boolean;
  onRename: (id: string, next: string) => void;
  onValidity: (key: string, valid: boolean) => void;
  references?: readonly string[];
}

/** Identifier drafts obey the same navigation protection as parameter drafts.
 * Invalid identifiers are the exception: they remain local and revert on blur.
 */
export function IdentifierField({ model, identifier, editable, onRename, onValidity, references = [] }: IdentifierFieldProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(identifier);
  const [reverted, setReverted] = useState(false);
  const error = editable ? identifierError(model, draft, identifier) : null;
  const message = error === t("app.structure.invalidId") && Object.hasOwn(model.blocks, identifier)
    ? t("editor.identifier.blockInvalid") : error;
  useBeforeUnload(editable && error === null && draft !== identifier);
  const validity = useRef(onValidity);
  useEffect(() => { validity.current = onValidity; }, [onValidity]);
  useEffect(() => { validity.current(`${identifier}.id`, true); }, [identifier]);
  useEffect(() => () => { validity.current(`${identifier}.id`, true); }, [identifier]);
  const commit = () => {
    if (editable && error === null && draft !== identifier) onRename(identifier, draft);
  };
  return (
    <div className="param-field identifier-field">
      <label htmlFor={inputId}>{t("editor.identifier")}</label>
      <input id={inputId} value={draft} readOnly={!editable} aria-invalid={error !== null}
        aria-describedby={[...(error === null ? [] : [`${inputId}-error`]), ...(references.length === 0 ? [] : [`${inputId}-references`])].join(" ") || undefined}
        onChange={(event) => { if (editable) { setDraft(event.target.value); setReverted(false); } }}
        onBlur={() => {
          if (error !== null) { setDraft(identifier); setReverted(true); }
          else commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { event.preventDefault(); setDraft(identifier); setReverted(false); }
        }} />
      {error === null ? null : <span id={`${inputId}-error`} className="param-error" role="alert">{message}</span>}
      {reverted ? <span className="param-description" role="status">{t("editor.identifier.reverted", { id: identifier })}</span> : null}
      {references.length === 0 ? null : <p id={`${inputId}-references`} className="inspector-type">{t("editor.identifier.references", { experiments: references.join(", ") })}</p>}
    </div>
  );
}
