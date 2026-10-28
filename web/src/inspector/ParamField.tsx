import { useEffect, useId, useRef, useState } from "react";
import type { Diagnostic, ParamDescriptor } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import { isObject } from "../workspace/params";
import { parseParam } from "../workspace/paramParsing";

export interface ParamFieldProps {
  descriptor: ParamDescriptor;
  /** Value written in the document; undefined when the default applies. */
  value: unknown;
  /** Dotted path from the element, used to mark overridden values. */
  path: string;
  editable: boolean;
  isOverridden: (path: string) => boolean;
  /** New value; undefined removes it from the document. */
  onCommit: (value: unknown) => void;
  /** Variant edits report the precise leaf path instead of replacing its enclosing object. */
  onFieldCommit?: (path: string, value: unknown) => void;
  /** Restore a variant field or complete object to the model value. */
  onReset?: (path: string) => void;
  /** Whether [path] has a valid editable draft; read-only values do not block editing elsewhere. Range errors are
   * committed document values; only unparseable text needs the loss-prevention guard. */
  onValidity: (path: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

/** A form field built from a catalog parameter descriptor (ADR 0001). */
export function ParamField(props: ParamFieldProps) {
  return props.descriptor.kind === "OBJECT" ? <ObjectField {...props} /> : <ScalarField {...props} />;
}

function ObjectField({ descriptor, value, path, editable, isOverridden, onCommit, onFieldCommit, onReset, onValidity, fieldDiagnostics }: ParamFieldProps) {
  const current = isObject(value) ? value : isObject(descriptor.default) ? descriptor.default : {};
  const [resetCount, setResetCount] = useState(0);
  return (
    <fieldset className={isOverridden(path) ? "param-group param-group--overridden" : "param-group"}>
      <legend title={descriptor.description}>{descriptor.title}</legend>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get(path)} />
      {isOverridden(path) && onReset !== undefined ? (
        <button type="button" className="param-reset" aria-label={`Reset ${descriptor.title}`} disabled={!editable}
          onClick={() => { setResetCount((count) => count + 1); onReset(path); }}>Use model value</button>
      ) : null}
      {descriptor.fields.map((field) => (
        <ParamField
          key={`${field.name}-${resetCount}`}
          descriptor={field}
          value={current[field.name]}
          path={`${path}.${field.name}`}
          editable={editable}
          isOverridden={isOverridden}
          onFieldCommit={onFieldCommit}
          onReset={onReset}
          onValidity={onValidity}
          fieldDiagnostics={fieldDiagnostics}
          onCommit={(next) => {
            const updated = { ...current };
            if (next === undefined) delete updated[field.name];
            else updated[field.name] = next;
            onCommit(updated);
          }}
        />
      ))}
    </fieldset>
  );
}

function ScalarField({ descriptor, value, path, editable, isOverridden, onCommit, onFieldCommit, onReset, onValidity, fieldDiagnostics }: ParamFieldProps) {
  const id = useId();
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const [previous, setPrevious] = useState(shown);
  if (previous !== shown) {
    setPrevious(shown);
    setDraft(shown);
  }
  const parsed = parseParam(descriptor, draft);
  const documentValue = parseParam(descriptor, draft, false);
  // Missing document values stay undoable; only unsaved unparseable text blocks navigation.
  const validDraft = documentValue.ok || draft === shown;
  const validityRef = useRef(onValidity);

  useEffect(() => {
    validityRef.current = onValidity;
  }, [onValidity]);

  useEffect(() => {
    validityRef.current(path, !editable || validDraft);
  }, [path, editable, validDraft]);

  useEffect(
    () => () => {
      validityRef.current(path, true);
    },
    [path],
  );
  const overridden = isOverridden(path);
  const fallback = descriptor.default == null ? "" : String(descriptor.default);
  const commitValue = (next: unknown) => onFieldCommit === undefined ? onCommit(next) : onFieldCommit(path, next);
  const diagnostics = fieldDiagnostics?.get(path) ?? [];
  const hasError = !parsed.ok || diagnostics.some((diagnostic) => diagnostic.severity === "ERROR");
  const commit = () => {
    // Keep malformed text in the field; parseable values, including range errors, must reach core draft validation.
    if (editable && documentValue.ok && draft.trim() !== shown) commitValue(documentValue.value);
  };

  return (
    <div className={overridden ? "param-field param-field--overridden" : "param-field"}>
      <label htmlFor={id} title={descriptor.description}>
        {descriptor.title}
      </label>
      {descriptor.kind === "CHOICE" ? (
        <select
          id={id}
          value={draft}
          disabled={!editable}
          aria-invalid={hasError || undefined}
          aria-describedby={diagnostics.length === 0 ? undefined : `${id}-diagnostics`}
          onChange={(event) => {
            if (!editable) return;
            setDraft(event.target.value);
            commitValue(event.target.value === "" ? undefined : event.target.value);
          }}
        >
          {descriptor.required ? <option value="" disabled>Select…</option> : <option value="">{fallback === "" ? "Default" : `Default (${fallback})`}</option>}
          {descriptor.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type="text"
          inputMode={descriptor.kind === "QUANTITY" ? "text" : "decimal"}
          value={draft}
          placeholder={fallback}
          readOnly={!editable}
          aria-invalid={hasError || undefined}
          aria-describedby={diagnostics.length === 0 ? undefined : `${id}-diagnostics`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      )}
      {overridden ? <span className="param-badge">overridden</span> : null}
      <DiagnosticMessages id={`${id}-diagnostics`} diagnostics={diagnostics} />
      {overridden && onReset !== undefined ? (
        <button type="button" className="param-reset" aria-label={`Reset ${descriptor.title}`} disabled={!editable}
          onClick={() => { setDraft(shown); onReset(path); }}>Use model value</button>
      ) : null}
      {parsed.ok ? null : (
        <span className="param-error" role="alert">
          {parsed.message}
        </span>
      )}
    </div>
  );
}
