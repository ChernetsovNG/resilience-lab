import { useId } from "react";
import { t } from "../i18n";
import type { Catalog, TypeDescriptor } from "../api/apiTypes";

function BlockIcon({ type }: { type: TypeDescriptor }) {
  if (type.id !== "client" && type.id !== "service") {
    return <span className="palette-icon" aria-hidden="true">{Array.from(type.title)[0] ?? t("editor.palette.unknownIcon")}</span>;
  }
  return <svg className="palette-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    {type.id === "client" ? <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M7 20h10" />
    </> : <>
      <rect x="4" y="3" width="16" height="7" rx="2" />
      <rect x="4" y="14" width="16" height="7" rx="2" />
      <path d="M7 6.5h2M7 17.5h2M12 10v4" />
    </>}
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
  const types = catalog?.types.filter((type) => type.category === "BLOCK") ?? [];
  return (
    <aside hidden={hidden} className="palette" aria-label={t("editor.palette.label")}>
      <ul>
        {types.map((type) => (
          <li key={type.id}>
            <button type="button" draggable={editable} disabled={!editable} aria-label={type.title}
              aria-describedby={`${tooltipId}-type-${type.id}`} onClick={() => onAdd(type.id)}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/resilience-lab-block", type.id);
                event.dataTransfer.effectAllowed = "copy";
              }}>
              <BlockIcon type={type} />
            </button>
            <span className="palette-tooltip" role="tooltip" id={`${tooltipId}-type-${type.id}`}>
              <strong>{type.title}</strong><span>{type.description}</span>
            </span>
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
