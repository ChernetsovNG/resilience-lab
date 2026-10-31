import { t } from "../i18n";
import { catalogOption, catalogText } from "../i18n/catalog";
import { useEffect, useId, useRef, useState } from "react";
import type { Catalog } from "../api/apiTypes";
import type { Params } from "../workspace/params";
import { catalogParameter, formatParameterValue } from "../workspace/parameterValues";
import { parseParam } from "../workspace/paramParsing";

export interface InlineParamEditorProps {
  catalog: Catalog;
  elementId: string;
  elementType: string;
  params: Params;
  modelParams?: Params;
  overridden?: boolean;
  path: string;
  editable: boolean;
  disabled?: boolean;
  onCommit: (value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}

/** A catalog-backed value on the canvas; only malformed drafts remain open and block loss-prone navigation. */
export function InlineParamEditor(props: InlineParamEditorProps) {
  const parameter = catalogParameter(props.catalog, props.elementType, props.params, props.path);
  return parameter === undefined ? null : <InlineValue {...props} parameter={parameter} />;
}

function InlineValue({ catalog, elementId, elementType, modelParams, overridden = false, path, editable, disabled = false, onCommit, onValidity, parameter }: InlineParamEditorProps & {
  parameter: NonNullable<ReturnType<typeof catalogParameter>>;
}) {
  const id = useId();
  const { descriptor, value } = parameter;
  const shown = value == null ? "" : String(value);
  const format = (value: unknown) => elementType === "router" && path === "policy"
    ? catalogText(`editor.canvas.policy.${value}`, formatParameterValue(value, descriptor))
    : formatParameterValue(value, descriptor);
  const full = formatParameterValue(value, descriptor);
  const displayed = value == null && !descriptor.required ? shown : format(value);
  const modelValue = modelParams === undefined ? undefined : catalogParameter(catalog, elementType, modelParams, path);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shown);
  const [previous, setPrevious] = useState(shown);
  if (previous !== shown) {
    setPrevious(shown);
    setDraft(shown);
    setEditing(false);
  }
  const parsed = parseParam(descriptor, draft);
  const documentValue = parseParam(descriptor, draft, false);
  const key = `${elementId}.${path}`;
  const valid = !editable || !editing || documentValue.ok || draft === shown;
  const validityRef = useRef(onValidity);

  useEffect(() => {
    validityRef.current = onValidity;
  }, [onValidity]);
  useEffect(() => {
    validityRef.current(key, valid);
  }, [key, valid]);
  useEffect(() => () => validityRef.current(key, true), [key]);

  const begin = () => {
    if (editing || !editable || disabled) return;
    setDraft(shown);
    setEditing(true);
  };
  const commit = () => {
    if (!documentValue.ok) return;
    if (draft.trim() !== shown) onCommit(documentValue.value);
    setEditing(false);
  };

  return (
    <span className="inline-param nodrag nopan" data-testid={`canvas-param-${elementId}-${path}`}
      data-element-id={elementId} data-param-path={path} onDoubleClick={begin}
      title={descriptor.kind === "CHOICE" ? full : undefined}>
      {overridden && modelValue !== undefined ? <del className="inline-param-model"
        title={t("editor.variant.modelValue", { value: formatParameterValue(modelValue.value, descriptor) })}>
        {format(modelValue.value)}
      </del> : null}
      {editing ? (
        <form className="inline-param-editor nodrag nopan" onSubmit={(event) => { event.preventDefault(); commit(); }}
          onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft(shown);
            setEditing(false);
          }}>
          <label className="visually-hidden" htmlFor={id}>{descriptor.title}</label>
          {descriptor.kind === "CHOICE" ? <select id={id} value={draft} autoFocus
            onChange={event => {
              const value = event.target.value;
              if (value !== shown) onCommit(value);
              setEditing(false);
            }} onBlur={commit}>
            {descriptor.options.map(option => <option key={option} value={option}>{catalogOption(option)}</option>)}
          </select> : <input
            id={id}
            type="text"
            inputMode={descriptor.kind === "QUANTITY" ? "text" : "decimal"}
            value={draft}
            autoFocus
            aria-invalid={!parsed.ok || undefined}
            aria-describedby={parsed.ok ? undefined : `${id}-error`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
          />}
          <button className="visually-hidden" type="submit">{t("editor.param.apply", { title: descriptor.title })}</button>
          {parsed.ok ? null : <span className="inline-param-error" id={`${id}-error`} role="alert">{parsed.message}</span>}
        </form>
      ) : editable ? (
        <button
          type="button"
          className="inline-param-value nodrag nopan"
          aria-label={t("editor.param.valueLabel", { title: descriptor.title, value: full })}
          aria-disabled={disabled || undefined}
          title={descriptor.kind === "CHOICE" ? `${full}${t("editor.symbols.separator")}${t("editor.param.editHint")}` : t("editor.param.editHint")}
          onClick={(event) => { if (event.detail === 0) begin(); }}
        >{displayed}</button>
      ) : <span className="inline-param-current">{displayed}</span>}
    </span>
  );
}
