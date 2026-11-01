import { useLayoutEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n";

/** A nonmodal estimate beside the run controls; dismissal never cancels the request or changes its budget decision. */
export function EstimatePopover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (event.target instanceof Node && !panel.current?.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [onClose]);
  return <section ref={panel} className="estimate-popover" aria-label={t("app.estimate.label")}>
    <button type="button" className="estimate-close" onClick={onClose}>{t("app.estimate.close")}</button>
    {children}
  </section>;
}
