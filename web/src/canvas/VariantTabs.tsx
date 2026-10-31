import { useEffect, useId, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import type { Variant } from "../api/apiTypes";
import type { EditorCommand } from "../workspace/editor";
import { addVariant, nextVariantId, removeVariant } from "../workspace/experimentCommands";
import { variantLabel } from "../presentation/labels";
import { useConfirmation } from "../components/useConfirmation";

export interface VariantTabsProps {
  variants: Variant[];
  /** ID of the active variant page; null for the model page. */
  active: string | null;
  /** Prevent leaving an invalid editable draft. */
  disabled?: boolean;
  onSelect: (id: string | null) => void;
  onInspect: (id: string, focusLabel?: boolean) => void;
  onCommand: (command: EditorCommand) => void;
}

/**
 * Pages below the canvas, as in draw.io (product vision §5.5): the model page first, then one page per variant. Only
 * the model page edits the model; a variant page edits its overrides, even when there are none yet.
 */
export function VariantTabs({ variants, active, disabled: navigationDisabled = false, onSelect, onInspect, onCommand }: VariantTabsProps) {
  const { confirm, confirmationDialog } = useConfirmation();
  const [creating, startCreating] = useTransition();
  const disabled = navigationDisabled || creating;
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; tab: HTMLButtonElement } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const explanationId = useId();
  const variant = variants.find(candidate => candidate.id === menu?.id);
  if (menu !== null && (disabled || variant === undefined)) setMenu(null);
  useEffect(() => {
    if (menu === null || panel.current === null) return;
    const element = panel.current;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) setMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const close = () => { setMenu(null); menu?.tab.focus(); };
  const add = (source?: Variant) => {
    if (disabled) return;
    const id = nextVariantId(variants);
    startCreating(() => {
      onCommand(addVariant(id, source === undefined ? t("editor.variant.newLabel", { number: id.slice(8) })
        : t("editor.variant.copyLabel", { label: variantLabel(source, variants) }), source?.id));
      onInspect(id);
    });
  };
  return (
    <>
      <div className="variant-tabs" role="tablist" aria-label={t("editor.pages.label")}>
        <button type="button" role="tab" className="model-page-tab" title={t("editor.pages.modelHint")}
          disabled={disabled} aria-selected={active === null} onClick={() => onSelect(null)}>
          {t("editor.pages.model")}
        </button>
        <span className="variant-tabs-label">{t("editor.pages.variants")}</span>
        {variants.map((variant) => (
          <button
            key={variant.id}
            id={`variant-${encodeURIComponent(variant.id)}`}
            type="button"
            role="tab"
            disabled={disabled}
            aria-selected={variant.id === active}
            title={t(Object.keys(variant.overrides).length === 1 ? "editor.pages.variantHintOne" : "editor.pages.variantHint", {
              name: variantLabel(variant, variants), count: Object.keys(variant.overrides).length,
            })}
            aria-haspopup="menu"
            aria-expanded={menu?.id === variant.id}
            onClick={() => onSelect(variant.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!disabled) setMenu({ id: variant.id, x: event.clientX, y: event.clientY, tab: event.currentTarget });
            }}
            onKeyDown={(event) => {
              if (disabled || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ id: variant.id, x: bounds.left, y: bounds.bottom, tab: event.currentTarget });
            }}
          >
            {variantLabel(variant, variants)}
          </button>
        ))}
        <button type="button" disabled={disabled} aria-busy={creating} aria-label={t("editor.variant.add")}
          onClick={event => { if (event.detail <= 1) add(); }}>
          {t(creating ? "editor.variant.creating" : "editor.pages.add")}
        </button>
      </div>
      {menu === null || variant === undefined || disabled ? null : createPortal(
        <div ref={panel} role="menu" className="variant-menu" aria-label={t("editor.variant.menu")}
          style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); close(); }
            else if (event.key === "Tab") setMenu(null);
            else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}>
          <button type="button" role="menuitem" onClick={() => { close(); add(variant); }}>{t("editor.variant.copy")}</button>
          <button type="button" role="menuitem" onClick={() => { close(); onInspect(variant.id, true); }}>{t("editor.variant.rename")}</button>
          <button type="button" role="menuitem" disabled={variants.length <= 1}
            aria-describedby={variants.length <= 1 ? explanationId : undefined}
            onClick={async () => {
              close();
              if (await confirm({ title: t("editor.variant.deleteConfirm", { label: variantLabel(variant, variants) }),
                confirmLabel: t("editor.variant.delete"), cancelLabel: t("file.cancel") })) onCommand(removeVariant(variant.id));
            }}>{t("editor.variant.delete")}</button>
          {variants.length <= 1 ? <p id={explanationId} className="param-description">{t("editor.variant.lastVariant")}</p> : null}
        </div>, document.body)}
      {confirmationDialog}
    </>
  );
}
