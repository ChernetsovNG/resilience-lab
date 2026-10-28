import { useEffect, useId, useRef, useState } from "react";
import type { ModelFile } from "../api/apiTypes";
import { identifierError } from "../workspace/structure";

interface IdentifierFieldProps {
  model: ModelFile;
  identifier: string;
  editable: boolean;
  onRename: (id: string, next: string) => void;
  onValidity: (key: string, valid: boolean) => void;
}

/** Identifier drafts obey the same navigation protection as parameter drafts. */
export function IdentifierField({ model, identifier, editable, onRename, onValidity }: IdentifierFieldProps) {
  const inputId = useId();
  const [draft, setDraft] = useState(identifier);
  const error = editable ? identifierError(model, draft, identifier) : null;
  const validity = useRef(onValidity);
  useEffect(() => { validity.current = onValidity; }, [onValidity]);
  useEffect(() => { validity.current(`${identifier}.id`, error === null); }, [identifier, error]);
  useEffect(() => () => { validity.current(`${identifier}.id`, true); }, [identifier]);
  const commit = () => {
    if (editable && error === null && draft !== identifier) onRename(identifier, draft);
  };
  return (
    <div className="param-field">
      <label htmlFor={inputId}>Identifier</label>
      <input id={inputId} value={draft} readOnly={!editable} aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : `${inputId}-error`}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { event.preventDefault(); setDraft(identifier); }
        }} />
      {error === null ? null : <span id={`${inputId}-error`} className="param-error" role="alert">{error}</span>}
    </div>
  );
}
