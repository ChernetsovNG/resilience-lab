import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";

/** Field help in the browser top layer, shared by editable fields, estimates and progress. */
export function HelpHint({ label, children, id: suppliedId }: { label: string; children: ReactNode; id?: string }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    if (!open) return;
    const popup = panel.current!;
    if (popup.showPopover) popup.showPopover();
    else popup.style.display = "block";
    const position = () => {
      const anchor = button.current!.getBoundingClientRect();
      const bounds = popup.getBoundingClientRect();
      const gap = 8;
      popup.style.left = Math.max(gap, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - gap)) + "px";
      const below = anchor.bottom + 4;
      const top = below + bounds.height <= window.innerHeight - gap ? below : anchor.top - bounds.height - 4;
      popup.style.top = Math.max(gap, Math.min(top, window.innerHeight - bounds.height - gap)) + "px";
    };
    position();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    // Capture before surrounding popovers and workspace shortcuts see Escape.
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      popup.hidePopover?.();
      popup.style.removeProperty("display");
      clearTimeout(leave.current);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open, children]);

  return <span ref={root} className="help-hint"
    onMouseEnter={() => { clearTimeout(leave.current); setOpen(true); }}
    onMouseLeave={() => {
      leave.current = setTimeout(() => {
        if (!root.current?.contains(document.activeElement)) setOpen(false);
      }, 150);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={button} type="button" className="help-hint-button"
      aria-label={t("help.more", { field: label })} aria-describedby={id} aria-expanded={open}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)}>{t("help.symbol")}</button>
    <div ref={panel} id={id} role="tooltip" popover="manual" hidden={!open} className="help-hint-popover">{children}</div>
  </span>;
}
