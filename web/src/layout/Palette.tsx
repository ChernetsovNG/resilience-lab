import type { Catalog, TypeDescriptor } from "../api/apiTypes";

function TypeList({ title, types }: { title: string; types: TypeDescriptor[] }) {
  return (
    <>
      <h2>{title}</h2>
      <ul>
        {types.map((type) => (
          <li key={type.id} title={type.description}>
            {type.title}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Computable types of the catalog; dragging them onto the canvas arrives with the editor track. */
export function Palette({ catalog }: { catalog: Catalog | null }) {
  const types = catalog?.types ?? [];
  return (
    <aside className="palette" aria-label="Palette">
      <TypeList title="Blocks" types={types.filter((type) => type.category === "BLOCK")} />
      <TypeList title="Connections" types={types.filter((type) => type.category === "CONNECTION")} />
    </aside>
  );
}
