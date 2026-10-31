import type { TypeDescriptor } from "../api/apiTypes";
import { t } from "../i18n";

/** The same catalog type icon in the palette and on a canvas node. */
export function BlockIcon({ type }: { type: Pick<TypeDescriptor, "id" | "title"> }) {
  if (!["client", "service", "router", "database", "pooler"].includes(type.id)) {
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
    </> : type.id === "database" ? <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </> : type.id === "pooler" ? <>
      <rect x="2" y="3" width="20" height="18" rx="3" />
      <rect x="5" y="6" width="14" height="12" rx="1" />
      <path d="M8 10h8M8 14h8" />
    </> : <path d="M3 12h6m0 0 6-7h6m-12 7h12m-12 0 6 7h6M18 2l3 3-3 3M18 9l3 3-3 3M18 16l3 3-3 3" />}
  </svg>;
}
