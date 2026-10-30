import { setLanguage, t, type Language } from "../i18n";
import { useLanguage } from "../i18n/useLanguage";
import { formatPercent } from "../i18n/format";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "../results/confidence";
import { setConfidenceLevel, useConfidenceLevel } from "./confidenceLevel";

/** Browser view preferences are independent of workspace documents and editor history. */
export function ViewMenu() {
  const language = useLanguage();
  const confidenceLevel = useConfidenceLevel();
  return <div className="view-menu" onKeyDown={event => {
    if (event.key === "Escape" && event.currentTarget.querySelector(":popover-open") !== null) event.stopPropagation();
  }}>
    <button type="button" popoverTarget="view-menu" aria-label={t("app.view.title")} title={t("app.view.title")}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="white" />
        <circle cx="15" cy="12" r="2" fill="white" /><circle cx="9" cy="18" r="2" fill="white" />
      </svg>
    </button>
    <div id="view-menu" popover="auto" className="view-menu-panel">
      <label>{t("app.view.language")} <select aria-label={t("app.view.language")} value={language} onChange={event => setLanguage(event.target.value as Language)}>
        <option value="en">{t("app.view.english")}</option>
        <option value="ru">{t("app.view.russian")}</option>
      </select></label>
      <label>{t("app.view.confidenceLevel")} <select aria-label={t("app.view.confidenceLevel")} value={confidenceLevel}
        onChange={event => setConfidenceLevel(Number(event.target.value) as ConfidenceLevel)}>
        {CONFIDENCE_LEVELS.map(level => <option key={level} value={level}>{formatPercent(level / 100)}</option>)}
      </select></label>
    </div>
  </div>;
}
