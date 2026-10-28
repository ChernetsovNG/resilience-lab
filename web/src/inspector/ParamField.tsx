import { useEffect, useId, useRef, useState } from "react";
import type { Diagnostic, ParamDescriptor } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import { isObject } from "../workspace/params";
import { canonicalOf } from "../workspace/quantities";

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
  /** Whether [path] has a valid editable draft; read-only values do not block editing elsewhere. Range errors are
   * committed document values; only unparseable text needs the loss-prevention guard. */
  onValidity: (path: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

/** A form field built from a catalog parameter descriptor (ADR 0001). */
export function ParamField(props: ParamFieldProps) {
  return props.descriptor.kind === "OBJECT" ? <ObjectField {...props} /> : <ScalarField {...props} />;
}

function ObjectField({ descriptor, value, path, editable, isOverridden, onCommit, onValidity, fieldDiagnostics }: ParamFieldProps) {
  const current = isObject(value) ? value : isObject(descriptor.default) ? descriptor.default : {};
  return (
    <fieldset className={isOverridden(path) ? "param-group param-group--overridden" : "param-group"}>
      <legend title={descriptor.description}>{descriptor.title}</legend>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get(path)} />
      {descriptor.fields.map((field) => (
        <ParamField
          key={field.name}
          descriptor={field}
          value={current[field.name]}
          path={`${path}.${field.name}`}
          editable={editable}
          isOverridden={isOverridden}
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

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parse(descriptor: ParamDescriptor, draft: string, checkRange = true): Parsed {
  const text = draft.trim();
  if (text === "") return descriptor.required ? { ok: false, message: "Required" } : { ok: true, value: undefined };
  switch (descriptor.kind) {
    case "INTEGER":
      return Number.isSafeInteger(Number(text)) ? inRange(descriptor, Number(text), Number(text), checkRange) : { ok: false, message: "Enter a whole number" };
    case "NUMBER":
      return Number.isFinite(Number(text)) ? inRange(descriptor, Number(text), Number(text), checkRange) : { ok: false, message: "Enter a number" };
    case "QUANTITY": {
      if (descriptor.units.length === 0) return { ok: true, value: text };
      const canonical = canonicalOf(text, descriptor.units);
      return canonical === null
        ? { ok: false, message: `Use a value with a unit: ${descriptor.units.map((unit) => unit.symbol).join(", ")}` }
        : inRange(descriptor, canonical, text, checkRange);
    }
    default:
      return { ok: true, value: text };
  }
}

/** Accepts [value] when its [canonical] number lies in the catalog range, which is in canonical units as in the core.
 * Draft parsing may skip range checks so the core can diagnose the resulting document. */
function inRange(descriptor: ParamDescriptor, canonical: number, value: unknown, checkRange: boolean): Parsed {
  const { minimum, exclusiveMinimum, maximum } = descriptor;
  const below = (minimum != null && canonical < minimum) || (exclusiveMinimum != null && canonical <= exclusiveMinimum);
  const above = maximum != null && canonical > maximum;
  if (!checkRange || (!below && !above)) return { ok: true, value };
  const unit = descriptor.units[0];
  const shown = (bound: number) => (unit === undefined ? String(bound) : `${(bound * unit.denominator) / unit.numerator}${unit.symbol}`);
  const limits = [
    minimum == null ? null : `>= ${shown(minimum)}`,
    exclusiveMinimum == null ? null : `> ${shown(exclusiveMinimum)}`,
    maximum == null ? null : `<= ${shown(maximum)}`,
  ];
  return { ok: false, message: `Out of range: ${limits.filter((limit) => limit !== null).join(" and ")}` };
}

function ScalarField({ descriptor, value, path, editable, isOverridden, onCommit, onValidity, fieldDiagnostics }: ParamFieldProps) {
  const id = useId();
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const [previous, setPrevious] = useState(shown);
  if (previous !== shown) {
    setPrevious(shown);
    setDraft(shown);
  }
  const parsed = parse(descriptor, draft);
  const documentValue = parse(descriptor, draft, false);
  const validityRef = useRef(onValidity);

  useEffect(() => {
    validityRef.current = onValidity;
  }, [onValidity]);

  useEffect(() => {
    validityRef.current(path, !editable || documentValue.ok);
  }, [path, editable, documentValue.ok]);

  useEffect(
    () => () => {
      validityRef.current(path, true);
    },
    [path],
  );
  const overridden = isOverridden(path);
  const fallback = descriptor.default == null ? "" : String(descriptor.default);
  const diagnostics = fieldDiagnostics?.get(path) ?? [];
  const hasError = !parsed.ok || diagnostics.some((diagnostic) => diagnostic.severity === "ERROR");
  const commit = () => {
    // Keep malformed text in the field; parseable values, including range errors, must reach core draft validation.
    if (editable && documentValue.ok && draft.trim() !== shown) onCommit(documentValue.value);
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
            onCommit(event.target.value === "" ? undefined : event.target.value);
          }}
        >
          {descriptor.required ? null : <option value="">{fallback === "" ? "Default" : `Default (${fallback})`}</option>}
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
      {parsed.ok ? null : (
        <span className="param-error" role="alert">
          {parsed.message}
        </span>
      )}
    </div>
  );
}
