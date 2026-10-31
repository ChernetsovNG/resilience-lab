import { useBeforeUnload } from "../components/useBeforeUnload";
import { useState } from "react";
import { t } from "../i18n";
import type { AnnotationField, Annotations } from "../workspace/annotations";

/** Free text commits on blur, keeping line breaks and surrounding whitespace. */
function AnnotationText({ field, value, editable, path, onCommit }: {
  field: AnnotationField; value: string; editable: boolean; path: string; onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [previous, setPrevious] = useState(value);
  if (previous !== value) { setPrevious(value); setDraft(value); }
  useBeforeUnload(editable && draft !== value);
  return <div className="param-field annotation-field" data-inspector-field={path}>
    <label>{t(`editor.annotations.${field}`)}
      <textarea value={draft} readOnly={!editable} rows={field === "notes" ? 4 : 2}
        onChange={event => { if (editable) setDraft(event.target.value); }}
        onBlur={() => { if (editable && draft !== value) onCommit(draft); }} />
    </label>
  </div>;
}

/** Shared model/document annotations; variants expose only their description. */
export function AnnotationFields({ value, editable, prefix = "", fields = ["description", "notes"], readOnlyHint, onCommit }: {
  value: Annotations; editable: boolean; prefix?: string; fields?: readonly AnnotationField[]; readOnlyHint?: string;
  onCommit: (field: AnnotationField, value: string) => void;
}) {
  return <>
    {readOnlyHint === undefined ? null : <p className="param-description">{readOnlyHint}</p>}
    {fields.map(field => <AnnotationText key={field} field={field} path={`${prefix}${field}`}
      value={value[field] ?? ""} editable={editable} onCommit={text => onCommit(field, text)} />)}
  </>;
}
