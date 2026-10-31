import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { Catalog, TypeDescriptor } from "../api/apiTypes";
import { TypeHelp } from "../help/TypeHelp";

function BlockIcon({ type }: { type: TypeDescriptor }) {
  if (type.id !== "client" && type.id !== "service" && type.id !== "router") {
    return <span className="palette-icon" aria-hidden="true">{Array.from(type.title)[0] ?? t("editor.palette.unknownIcon")}</span>;
  }
  return <svg className="palette-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    {type.id === "client" ? <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M7 20h10" />
    </> : type.id === "service" ? <>
      <rect x="4" y="3" width="16" height="7" rx="2" />
      <rect x="4" y="14" width="16" height="7" rx="2" />
      <path d="M7 6.5h2M7 17.5h2M12 10v4" />
    </> : <path d="M3 12h6m0 0 6-7h6m-12 7h12m-12 0 6 7h6M18 2l3 3-3 3M18 9l3 3-3 3M18 16l3 3-3 3" />}
  </svg>;
}

/** Catalog block icons support native button activation as well as dragging onto the model page. */
export function Palette({ catalog, editable = false, onAdd, hidden = false }: {
  catalog: Catalog | null;
  editable?: boolean;
  hidden?: boolean;
  onAdd: (type: string) => void;
}) {
  const tooltipId = useId();
  // Clicking an already-focused button can retain :focus-visible.
  const [pointerFocus, setPointerFocus] = useState(false);
  const [details, setDetails] = useState<{ type: string; anchor: HTMLButtonElement } | null>(null);
  const close = useCallback((restoreFocus = false) => {
    setDetails(null);
    if (restoreFocus) details?.anchor.focus();
  }, [details]);
  if (hidden && details !== null) setDetails(null);
  const types = catalog?.types.filter((type) => type.category === "BLOCK") ?? [];
  const add = (type: string) => {
    if (!editable) return;
    close(true);
    onAdd(type);
  };
  return (
    <aside hidden={hidden} className="palette" aria-label={t("editor.palette.label")}
      data-pointer-focus={pointerFocus || undefined}
      onPointerDownCapture={() => setPointerFocus(true)}
      onKeyDownCapture={() => setPointerFocus(false)}
      onBlurCapture={() => setPointerFocus(false)}>
      <ul>
        {types.map((type) => (
          <li key={type.id} className={details?.type === type.id ? "palette-item--open" : undefined}>
            <button type="button" draggable={editable} aria-label={type.title}
              aria-expanded={details?.type === type.id} aria-controls={details?.type === type.id ? `${tooltipId}-card` : undefined}
              aria-describedby={`${tooltipId}-type-${type.id}`}
              onClick={event => {
                if (event.detail < 2) setDetails(details?.type === type.id ? null : { type: type.id, anchor: event.currentTarget });
              }}
              onDoubleClick={() => add(type.id)}
              onKeyDown={event => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (!event.repeat) add(type.id);
              }}
              onDragStart={(event) => {
                if (!editable) { event.preventDefault(); return; }
                close();
                event.dataTransfer.setData("application/resilience-lab-block", type.id);
                event.dataTransfer.effectAllowed = "copy";
              }}>
              <BlockIcon type={type} />
            </button>
            <span className="palette-tooltip" role="tooltip" id={`${tooltipId}-type-${type.id}`}>
              <strong>{type.title}</strong>
            </span>
            {details?.type !== type.id || catalog === null ? null : <PaletteDetails id={`${tooltipId}-card`}
              catalog={catalog} type={type} anchor={details.anchor} editable={editable} onAdd={() => add(type.id)} onClose={close} />}
          </li>
        ))}
        <li className="palette-help">
          <button type="button" aria-label={t("editor.palette.connectBlocks")} aria-describedby={`${tooltipId}-help`}>
            <svg className="palette-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="9" /><path d="M12 10v7M12 6v1" />
            </svg>
          </button>
          <span className="palette-tooltip" role="tooltip" id={`${tooltipId}-help`}>{t("editor.palette.connectionHint")}</span>
        </li>
      </ul>
    </aside>
  );
}

function PaletteDetails({ id, catalog, type, anchor, editable, onAdd, onClose }: {
  id: string; catalog: Catalog; type: TypeDescriptor; anchor: HTMLButtonElement; editable: boolean;
  onAdd: () => void; onClose: (restoreFocus?: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = panel.current!;
    if (popup.showPopover) popup.showPopover();
    else popup.style.display = "block";
    const position = () => {
      const button = anchor.getBoundingClientRect();
      const bounds = popup.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(button.right + 8, window.innerWidth - bounds.width - 8)) + "px";
      popup.style.top = Math.max(8, Math.min(button.top, window.innerHeight - bounds.height - 8)) + "px";
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    position();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      popup.hidePopover?.();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [anchor, onClose]);

  return <div ref={panel} id={id} popover="manual" role="dialog" aria-label={t("editor.palette.details", { type: type.title })}
    aria-describedby={`${id}-description`}
    className="palette-card">
    <h3>{type.title}</h3>
    <p id={`${id}-description`}>{type.description}</p>
    <div className="palette-card-actions">
      <button type="button" disabled={!editable} onClick={onAdd}>{t("editor.palette.add")}</button>
      <TypeHelp catalog={catalog} typeId={type.id}>{t("editor.palette.help")}</TypeHelp>
    </div>
  </div>;
}
