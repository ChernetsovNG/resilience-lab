import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { useEffect, useId, useRef, useState } from "react";
import type { Catalog } from "../api/apiTypes";
import { isObject, type Params } from "../workspace/params";
import { parseParam } from "../workspace/paramParsing";

export interface InlineParamEditorProps {
  catalog: Catalog;
  elementId: string;
  elementType: string;
  params: Params;
  path: string;
  editable: boolean;
  disabled?: boolean;
  onCommit: (value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
}

function catalogParameter(catalog: Catalog, type: string, params: Params, path: string) {
  const [root, ...fields] = path.split(".");
  let descriptor = catalog.types.find((candidate) => candidate.id === type)?.params.find((param) => param.name === root);
  if (descriptor === undefined) return undefined;
  let value = params[root] ?? descriptor.default;
  for (const field of fields) {
    descriptor = descriptor.fields.find((param) => param.name === field)!;
    value = (isObject(value) ? value[field] : undefined) ?? descriptor?.default;
  }
  return { descriptor, value };
}

/** A catalog-backed value on the canvas; only malformed drafts remain open and block loss-prone navigation. */
export function InlineParamEditor({ catalog, elementId, elementType, params, path, editable, disabled = false, onCommit, onValidity }: InlineParamEditorProps) {
  const id = useId();
  const { descriptor, value } = catalogParameter(catalog, elementType, params, path)!;
  const shown = value == null ? descriptor.required ? t("editor.param.required") : "" : String(value);
  const displayed = typeof value === "number" ? formatNumber(value) : shown;
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
    <span className="inline-param nodrag nopan" data-testid={`canvas-param-${elementId}-${path}`} onDoubleClick={begin}>
      {editing ? (
        <form className="inline-param-editor nodrag nopan" onSubmit={(event) => { event.preventDefault(); commit(); }}>
          <label className="visually-hidden" htmlFor={id}>{descriptor.title}</label>
          <input
            id={id}
            type="text"
            inputMode={descriptor.kind === "QUANTITY" ? "text" : "decimal"}
            value={draft}
            autoFocus
            aria-invalid={!parsed.ok || undefined}
            aria-describedby={parsed.ok ? undefined : `${id}-error`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setDraft(shown);
              setEditing(false);
            }}
          />
          <button className="visually-hidden" type="submit">{t("editor.param.apply", { title: descriptor.title })}</button>
          {parsed.ok ? null : <span className="inline-param-error" id={`${id}-error`} role="alert">{parsed.message}</span>}
        </form>
      ) : editable ? (
        <button
          type="button"
          className="inline-param-value nodrag nopan"
          aria-label={t("editor.param.valueLabel", { title: descriptor.title, value: displayed })}
          aria-disabled={disabled || undefined}
          title={t("editor.param.editHint")}
          onClick={(event) => { if (event.detail === 0) begin(); }}
        >{displayed}</button>
      ) : displayed}
    </span>
  );
}
