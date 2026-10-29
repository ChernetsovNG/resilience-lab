import { t } from "../i18n";
import type { Variant } from "../api/apiTypes";

export interface VariantTabsProps {
  variants: Variant[];
  /** ID of the active variant page; null for the model page. */
  active: string | null;
  /** Prevent leaving an invalid editable draft. */
  disabled?: boolean;
  onSelect: (id: string | null) => void;
}

/**
 * Pages below the canvas, as in draw.io (product vision §5.5): the model page first, then one page per variant. Only
 * the model page edits the model; a variant page edits its overrides, even when there are none yet.
 */
export function VariantTabs({ variants, active, disabled = false, onSelect }: VariantTabsProps) {
  return (
    <div className="variant-tabs" role="tablist" aria-label={t("editor.pages.label")}>
      <button type="button" role="tab" disabled={disabled} aria-selected={active === null} onClick={() => onSelect(null)}>
        {t("editor.pages.model")}
      </button>
      {variants.map((variant) => (
        <button
          key={variant.id}
          type="button"
          role="tab"
          disabled={disabled}
          aria-selected={variant.id === active}
          onClick={() => onSelect(variant.id)}
        >
          {variant.label ?? variant.id}
        </button>
      ))}
    </div>
  );
}
