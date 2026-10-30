import { t } from "../i18n";
import { HelpHint } from "../help/HelpHint";
import { catalogOption } from "../i18n/catalog";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Diagnostic, ParamDescriptor } from "../api/apiTypes";
import { DiagnosticMessages, VariantDiagnosticLinks } from "../validation/DiagnosticDisplay";
import { isObject } from "../workspace/params";
import { initialParams } from "../workspace/initialParams";
import { parseParam } from "../workspace/paramParsing";

export interface ParamFieldProps {
  descriptor: ParamDescriptor;
  /** Value written in the document; undefined when the default applies. */
  value: unknown;
  /** Dotted path from the element, used to mark overridden values. */
  path: string;
  editable: boolean;
  /** An action beside the scalar input, under the same field label. */
  inputAction?: ReactNode;
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
  variantFieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onVariantDiagnostic?: (variant: string, field: string) => void;
  navigationDisabled?: boolean;
}

/** A form field built from a catalog parameter descriptor (ADR 0001). */
export function ParamField(props: ParamFieldProps) {
  if (props.descriptor.kind === "ARRAY") return <ArrayField {...props} />;
  return props.descriptor.kind === "OBJECT" ? <ObjectField {...props} /> : <ScalarField {...props} />;
}

function ArrayField({ descriptor, value, path, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic, navigationDisabled }: ParamFieldProps) {
  const id = useId();
  return <div className="param-field" data-inspector-field={path}>
    <div className="param-field-label"><label htmlFor={id}>{descriptor.title}</label>
      {descriptor.description ? <HelpHint id={id + "-description"} label={descriptor.title}>{descriptor.description}</HelpHint> : null}</div>
    <textarea id={id} readOnly value={JSON.stringify(value ?? descriptor.default ?? null, null, 2)}
      aria-describedby={descriptor.description ? id + "-description" : undefined} />
    <DiagnosticMessages diagnostics={fieldDiagnostics?.get(path)} />
    <VariantDiagnosticLinks diagnostics={variantFieldDiagnostics?.get(path)} disabled={navigationDisabled}
      onSelect={variant => onVariantDiagnostic?.(variant, path)} />
  </div>;
}

function ObjectField({ descriptor, value, path, editable, isOverridden, onCommit, onFieldCommit, onReset, onValidity, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic, navigationDisabled }: ParamFieldProps) {
  const id = useId();
  const current = isObject(value) ? value : isObject(descriptor.default) ? descriptor.default : {};
  const [resetCount, setResetCount] = useState(0);
  return (
    <fieldset className={isOverridden(path) ? "param-group param-group--overridden" : "param-group"}
      data-inspector-field={path} aria-label={descriptor.title} aria-describedby={descriptor.description ? `${id}-description` : undefined}>
      <legend>{descriptor.title} {descriptor.description ? <HelpHint id={id + "-description"} label={descriptor.title}>{descriptor.description}</HelpHint> : null}</legend>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get(path)} />
      <VariantDiagnosticLinks diagnostics={variantFieldDiagnostics?.get(path)} disabled={navigationDisabled}
        onSelect={variant => onVariantDiagnostic?.(variant, path)} />
      {isOverridden(path) && onReset !== undefined ? (
        <button type="button" className="param-reset" aria-label={t("editor.param.reset", { title: descriptor.title })} disabled={!editable}
          onClick={() => { setResetCount((count) => count + 1); onReset(path); }}>{t("editor.param.useModelValue")}</button>
      ) : null}
      {value == null && descriptor.default == null && !descriptor.required
        ? <><p className="param-description">{t("editor.param.notSet")}</p>
          {editable ? <button type="button" onClick={() => {
            const initial = initialParams(descriptor.fields);
            if (onFieldCommit === undefined) onCommit(initial);
            else onFieldCommit(path, initial);
          }}>
            {t("editor.param.enable", { title: descriptor.title })}
          </button> : null}</>
        : descriptor.fields.map((field) => (
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
          variantFieldDiagnostics={variantFieldDiagnostics}
          onVariantDiagnostic={onVariantDiagnostic}
          navigationDisabled={navigationDisabled}
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

function ScalarField({ descriptor, value, path, editable, inputAction, isOverridden, onCommit, onFieldCommit, onReset, onValidity, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic, navigationDisabled }: ParamFieldProps) {
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
  const describedBy = [descriptor.description ? `${id}-description` : null, diagnostics.length > 0 ? `${id}-diagnostics` : null]
    .filter(Boolean).join(" ") || undefined;
  const hasError = !parsed.ok || diagnostics.some((diagnostic) => diagnostic.severity === "ERROR");
  const commit = () => {
    // Keep malformed text in the field; parseable values, including range errors, must reach core draft validation.
    if (editable && documentValue.ok && draft.trim() !== shown) commitValue(documentValue.value);
  };

  return (
    <div className={`param-field${overridden ? " param-field--overridden" : ""}${inputAction ? " param-field--with-action" : ""}`} data-inspector-field={path}>
      <div className="param-field-label"><label htmlFor={id}>{descriptor.title}</label>
        {descriptor.description ? <HelpHint id={id + "-description"} label={descriptor.title}>{descriptor.description}</HelpHint> : null}</div>
      {descriptor.kind === "CHOICE" ? (
        <select
          id={id}
          value={draft}
          disabled={!editable}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (!editable) return;
            setDraft(event.target.value);
            commitValue(event.target.value === "" ? undefined : event.target.value);
          }}
        >
          {descriptor.required ? <option value="" disabled>{t("editor.param.select")}</option> : <option value="">{fallback === "" ? t("editor.param.default") : t("editor.param.defaultValue", { value: catalogOption(fallback) })}</option>}
          {descriptor.options.map((option) => (
            <option key={option} value={option}>
              {catalogOption(option)}
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
          aria-describedby={describedBy}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      )}
      {inputAction}
      {overridden ? <span className="param-badge">{t("editor.param.overridden")}</span> : null}
      <DiagnosticMessages id={`${id}-diagnostics`} diagnostics={diagnostics} />
      <VariantDiagnosticLinks diagnostics={variantFieldDiagnostics?.get(path)} disabled={navigationDisabled}
        onSelect={variant => onVariantDiagnostic?.(variant, path)} />
      {overridden && onReset !== undefined ? (
        <button type="button" className="param-reset" aria-label={t("editor.param.reset", { title: descriptor.title })} disabled={!editable}
          onClick={() => { setDraft(shown); onReset(path); }}>{t("editor.param.useModelValue")}</button>
      ) : null}
      {parsed.ok ? null : (
        <span className="param-error" role="alert">
          {parsed.message}
        </span>
      )}
    </div>
  );
}
