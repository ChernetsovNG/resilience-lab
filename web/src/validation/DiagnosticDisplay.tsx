import { backendMessage } from "../i18n/backendMessage";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { Diagnostic } from "../api/apiTypes";
import { summarizeDiagnostics } from "./diagnostics";
import { HelpHint } from "../help/HelpHint";

/** Compact element badge with a count and the greatest severity. */
export function DiagnosticBadge({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  const summary = summarizeDiagnostics(diagnostics);
  if (summary === null) return null;
  return <span className={`diagnostic-badge diagnostic--${summary.severity.toLowerCase()}`} role="img"
    aria-label={t("editor.diagnostics.countLabel", { count: formatNumber(summary.count), severity: t(`results.problems.severity.${summary.severity}`).toLowerCase() })} title={diagnostics.map((item) => backendMessage(item)).join("\n")}>
    {t("editor.diagnostics.badge", { symbol: summary.severity === "ERROR" ? t("editor.symbols.error") : t("editor.symbols.warning"), count: formatNumber(summary.count) })}
  </span>;
}

/** Compiler messages next to a catalog or experiment field; warnings and errors remain distinguishable. */
export function DiagnosticMessages({ diagnostics = [], id }: { diagnostics?: readonly Diagnostic[]; id?: string }) {
  const summary = summarizeDiagnostics(diagnostics);
  return <span className={`field-feedback${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}>
    {summary === null ? null : <HelpHint id={id}
      label={t("editor.diagnostics.countLabel", { count: formatNumber(summary.count), severity: t(`results.problems.severity.${summary.severity}`).toLowerCase() })}
      symbol={t(summary.severity === "ERROR" ? "editor.symbols.error" : "editor.symbols.warning")}>
      <ul className="field-diagnostics">
        {diagnostics.map((diagnostic, index) => <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}
          role={diagnostic.severity === "ERROR" ? "alert" : "status"}>
          {t("editor.diagnostics.message", { code: diagnostic.code, message: backendMessage(diagnostic) })}
        </li>)}
      </ul>
    </HelpHint>}
  </span>;
}


/** Model-page summary of findings that belong to variant pages. */
export function VariantDiagnosticBadge({ diagnostics = [], onOpen, disabled = false }: {
  diagnostics?: readonly Diagnostic[]; onOpen?: () => void; disabled?: boolean;
}) {
  const summary = summarizeDiagnostics(diagnostics);
  if (summary === null) return null;
  const variants = [...new Set(diagnostics.flatMap(item => item.variant == null ? [] : [item.variant]))];
  const label = t(`editor.diagnostics.variants.${summary.severity}`, { variants: variants.join(", ") });
  return <button type="button" className={`diagnostic-badge diagnostic-badge--variants diagnostic--${summary.severity.toLowerCase()} nodrag nopan nokey`}
    title={label} aria-label={label} disabled={disabled} onClick={event => { event.stopPropagation(); onOpen?.(); }}>
    {t("editor.diagnostics.badge", { symbol: summary.severity === "ERROR" ? t("editor.symbols.error") : t("editor.symbols.warning"), count: formatNumber(summary.count) })}
  </button>;
}

/** Short per-variant counts; full messages stay on the variant page. */
export function VariantDiagnosticLinks({ diagnostics = [], onSelect, disabled = false }: {
  diagnostics?: readonly Diagnostic[]; onSelect?: (variant: string) => void; disabled?: boolean;
}) {
  const variants = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.variant != null) variants.set(diagnostic.variant, [...(variants.get(diagnostic.variant) ?? []), diagnostic]);
  }
  const summary = summarizeDiagnostics([...variants.values()].flat());
  return <span className={`field-feedback field-feedback--variants${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}>
    {summary === null ? null : <HelpHint interactive
      label={t(`editor.diagnostics.variants.${summary.severity}`, { variants: [...variants.keys()].join(", ") })}
      symbol={t(summary.severity === "ERROR" ? "editor.symbols.error" : "editor.symbols.warning")}>
    {[...variants].map(([variant, findings]) => {
    const counts = (["ERROR", "WARNING"] as const).flatMap(severity => {
      const count = findings.filter(finding => finding.severity === severity).length;
      return count === 0 ? [] : [t(`editor.diagnostics.variantCount.${severity}.${count === 1 ? "one" : "other"}`, { count: formatNumber(count) })];
    });
    return <p key={variant} className="variant-diagnostic-hint">
      <a href={`#variant-${encodeURIComponent(variant)}`} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
        onClick={event => { event.preventDefault(); if (!disabled) onSelect?.(variant); }}>
        {t("editor.diagnostics.inVariants", { variant, counts: counts.join(", ") })}
      </a>
    </p>;
    })}
    </HelpHint>}
  </span>;
}
