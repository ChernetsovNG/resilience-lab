import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n";
import { Icon } from "../layout/Icon";
import type { Annotations } from "../workspace/annotations";

/** Model information is a browser preference; it never edits documents or their undo history. */
export function ModelInfo({ modelPath, model, experiment, onFullNotes, notesDisabled = false }: {
  modelPath: string; model: Annotations; experiment: Annotations; onFullNotes: () => void; notesDisabled?: boolean;
}) {
  const key = `resilience-lab.model-info.${modelPath}`;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => {
    try { return localStorage.getItem(key) === "seen"; }
    catch { return false; }
  });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  if (![model.description, model.notes, experiment.description, experiment.notes].some(text => text?.trim())) return null;
  return <div ref={root} className="model-info nodrag nopan nowheel" onDoubleClick={event => event.stopPropagation()}>
    <button ref={button} type="button" className="model-info-trigger" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      title={t(seen ? "app.canvas.aboutModel" : "app.canvas.modelInfoUnread")}
      onClick={() => {
        setOpen(current => !current);
        setSeen(true);
        try { localStorage.setItem(key, "seen"); }
        catch { /* Information remains available when browser storage is disabled. */ }
      }}><Icon name="info" size={14} />{t("app.canvas.aboutModel")}
      {seen ? null : <span className="model-info-unread" aria-hidden="true" />}
    </button>
    {open ? <section id={id} role="dialog" aria-label={t("app.canvas.aboutModel")} className="model-info-panel">
      <header><strong>{t("app.canvas.aboutModel")}</strong>
        <button type="button" aria-label={t("app.canvas.closeModelInfo")} onClick={() => {
          setOpen(false); button.current?.focus();
        }}>{t("app.canvas.closeModelInfoSymbol")}</button>
      </header>
      <div className="model-info-copy">
        {([ ["model", model], ["experiment", experiment] ] as const).map(([name, value]) => {
          const text = value.description?.trim() ? value.description : value.notes;
          return text?.trim() ? <section key={name}>
            <h3>{t(`editor.annotations.${name}`)}</h3><p>{text}</p>
          </section> : null;
        })}
      </div>
      <button type="button" disabled={notesDisabled} onClick={() => {
        setOpen(false); onFullNotes();
      }}>{t("app.canvas.fullNotes")}</button>
    </section> : null}
  </div>;
}
