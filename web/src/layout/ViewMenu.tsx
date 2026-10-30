import { useEffect, useRef, useState } from "react";
import { setLanguage, t, type Language } from "../i18n";
import { useLanguage } from "../i18n/useLanguage";
import { formatPercent } from "../i18n/format";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "../results/confidence";
import { setConfidenceLevel, useConfidenceLevel } from "./confidenceLevel";
import { GRID_STEPS, TEXT_SCALES, setViewSettings, useViewSettings, type ViewSettings } from "./viewSettings";

/** Browser view preferences are independent of workspace documents and editor history. */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const language = useLanguage();
  const confidenceLevel = useConfidenceLevel();
  const settings = useViewSettings();
  useEffect(() => {
    if (!open) return;
    panel.current?.showPopover?.();
    const close = () => { setOpen(false); button.current?.focus(); };
    const outsideClick = (event: MouseEvent) => {
      if (!event.composedPath().includes(container.current!)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("click", outsideClick, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("click", outsideClick, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return <div ref={container} className="view-menu">
    <button ref={button} type="button" aria-controls="view-menu" aria-expanded={open}
      onClick={event => { setOpen(!open); event.currentTarget.focus(); }}
      aria-label={t("app.view.title")} title={t("app.view.title")}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="white" />
        <circle cx="15" cy="12" r="2" fill="white" /><circle cx="9" cy="18" r="2" fill="white" />
      </svg>
    </button>
    {open ? <div id="view-menu" ref={panel} popover="manual" className="view-menu-panel">
      <label>{t("app.view.gridStep")} <select aria-label={t("app.view.gridStep")} value={settings.gridStep}
        onChange={event => setViewSettings({ gridStep: Number(event.target.value) as ViewSettings["gridStep"] })}>
        {GRID_STEPS.map(step => <option key={step} value={step}>{step}</option>)}
      </select></label>
      <label>{t("app.view.snapToGrid")} <input type="checkbox" checked={settings.snapToGrid}
        onChange={event => setViewSettings({ snapToGrid: event.target.checked })} /></label>
      <label>{t("app.view.showGrid")} <input type="checkbox" checked={settings.showGrid}
        onChange={event => setViewSettings({ showGrid: event.target.checked })} /></label>
      <label>{t("app.view.textScale")} <select aria-label={t("app.view.textScale")} value={settings.textScale}
        onChange={event => setViewSettings({ textScale: Number(event.target.value) as ViewSettings["textScale"] })}>
        {TEXT_SCALES.map(scale => <option key={scale} value={scale}>{formatPercent(scale / 100)}</option>)}
      </select></label>
      <label>{t("app.view.language")} <select aria-label={t("app.view.language")} value={language} onChange={event => setLanguage(event.target.value as Language)}>
        <option value="en">{t("app.view.english")}</option>
        <option value="ru">{t("app.view.russian")}</option>
      </select></label>
      <label>{t("app.view.confidenceLevel")} <select aria-label={t("app.view.confidenceLevel")} value={confidenceLevel}
        onChange={event => setConfidenceLevel(Number(event.target.value) as ConfidenceLevel)}>
        {CONFIDENCE_LEVELS.map(level => <option key={level} value={level}>{formatPercent(level / 100)}</option>)}
      </select></label>
    </div> : null}
  </div>;
}
