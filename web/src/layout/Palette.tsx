import { t } from "../i18n";
import type { Catalog, TypeDescriptor } from "../api/apiTypes";

function TypeList({ title, types, editable }: { title: string; types: TypeDescriptor[]; editable: boolean }) {
  return (
    <>
      <h2>{title}</h2>
      <ul>
        {types.map((type) => (
          <li key={type.id} title={type.description}>
            {type.category === "BLOCK" ? (
              <button type="button" draggable={editable} disabled={!editable}
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/resilience-lab-block", type.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}>
                {type.title}
              </button>
            ) : type.title}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Computable types of the catalog; block types can be dragged onto the model page. */
export function Palette({ catalog, editable = false }: { catalog: Catalog | null; editable?: boolean }) {
  const types = catalog?.types ?? [];
  return (
    <aside className="palette" aria-label={t("editor.palette.label")}>
      <TypeList title={t("editor.palette.blocks")} types={types.filter((type) => type.category === "BLOCK")} editable={editable} />
      <TypeList title={t("editor.palette.connections")} types={types.filter((type) => type.category === "CONNECTION")} editable={false} />
    </aside>
  );
}
