import type { Variant } from "../api/apiTypes";

export interface VariantTabsProps {
  variants: Variant[];
  /** ID of the active variant page; null for the model page. */
  active: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * Pages below the canvas, as in draw.io (product vision §5.5): the model page first, then one page per variant. Only
 * the model page edits the model; a variant page shows it with the variant's overrides, even when there are none.
 */
export function VariantTabs({ variants, active, onSelect }: VariantTabsProps) {
  return (
    <div className="variant-tabs" role="tablist" aria-label="Pages">
      <button type="button" role="tab" aria-selected={active === null} onClick={() => onSelect(null)}>
        Model
      </button>
      {variants.map((variant) => (
        <button
          key={variant.id}
          type="button"
          role="tab"
          aria-selected={variant.id === active}
          onClick={() => onSelect(variant.id)}
        >
          {variant.label ?? variant.id}
        </button>
      ))}
    </div>
  );
}
