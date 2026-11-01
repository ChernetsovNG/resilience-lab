import { useId, useState } from "react";
import { useBeforeUnload } from "../components/useBeforeUnload";
import { t } from "../i18n";

/** Commit a display name as one history entry; clearing it restores the identifier as the label. */
export function BlockTitleField({ value = "", identifier, editable, onCommit }: {
  value?: string | null; identifier: string; editable: boolean; onCommit: (value: string) => void;
}) {
  const inputId = useId();
  const saved = value ?? "";
  const [draft, setDraft] = useState(saved);
  const [previous, setPrevious] = useState(saved);
  if (previous !== saved) { setPrevious(saved); setDraft(saved); }
  useBeforeUnload(editable && draft !== saved);
  const commit = () => {
    if (!editable) return;
    const title = draft.trim();
    setDraft(title);
    if (title !== saved) onCommit(title);
  };
  return <div className="param-field" data-inspector-field="title">
    <label htmlFor={inputId}>{t("editor.block.title")}</label>
    <input id={inputId} value={draft} placeholder={identifier} readOnly={!editable}
      onChange={event => { if (editable) setDraft(event.target.value); }} onBlur={commit}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(saved); }
      }} />
  </div>;
}
