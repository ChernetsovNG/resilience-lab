import { Icon } from "../layout/Icon";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { Diagnostic } from "../api/apiTypes";
import { groupDiagnostics, summarizeDiagnostics } from "./diagnostics";
import { HelpHint } from "../help/HelpHint";
import { useContext } from "react";
import { DiagnosticLabelContext } from "../presentation/diagnosticContext";
import { diagnosticGroupContext, diagnosticMessage, variantLabel, type NamedVariant } from "../presentation/labels";
import { backendMessage } from "../i18n/backendMessage";

/** Calculation details and stable rule identity stay behind the help control. */
export function LintDetails({ diagnostic }: { diagnostic: Diagnostic }) {
  const args = { ...diagnostic.args };
  delete args.points;
  delete args.replica;
  const details = backendMessage({ code: `${diagnostic.code}_DETAILS`, args, message: "" });
  return <>{details ? <p>{details}</p> : null}<code className="diagnostic-code">{diagnostic.code}</code></>;
}

/** Advice uses the existing neutral information icon; risks retain their symbols. */
export function DiagnosticSymbol({ severity }: { severity: Diagnostic["severity"] }) {
  return severity === "ADVICE" ? <Icon name="info" /> : t(severity === "ERROR" ? "editor.symbols.error" : "editor.symbols.warning");
}

function DiagnosticCounts({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  const risks = summarizeDiagnostics(diagnostics.filter(diagnostic => diagnostic.severity !== "ADVICE"));
  const advice = groupDiagnostics(diagnostics.filter(diagnostic => diagnostic.severity === "ADVICE")).length;
  return <>{risks === null ? null : <><DiagnosticSymbol severity={risks.severity} /> {formatNumber(risks.count)}</>}
    {advice === 0 ? null : <span className="diagnostic--advice">{risks === null ? null : t("editor.symbols.separator")}<DiagnosticSymbol severity="ADVICE" /> {formatNumber(advice)}</span>}</>;
}

function diagnosticCountLabel(diagnostics: readonly Diagnostic[]) {
  return [diagnostics.filter(item => item.severity !== "ADVICE"), diagnostics.filter(item => item.severity === "ADVICE")]
    .flatMap(findings => {
      const summary = summarizeDiagnostics(findings);
      return summary === null ? [] : [t("editor.diagnostics.countLabel", { count: formatNumber(summary.count),
        severity: t(`results.problems.severity.${summary.severity}`).toLowerCase() })];
    }).join("; ");
}

function variantDiagnosticLabel(diagnostics: readonly Diagnostic[], labels: readonly NamedVariant[]) {
  return [diagnostics.filter(item => item.severity !== "ADVICE"), diagnostics.filter(item => item.severity === "ADVICE")]
    .flatMap(findings => {
      const summary = summarizeDiagnostics(findings);
      const variants = [...new Set(findings.flatMap(item => item.variant == null ? [] : [item.variant]))];
      return summary === null ? [] : [t(`editor.diagnostics.variants.${summary.severity}`, { variants: variants
        .map(id => variantLabel(labels.find(variant => variant.id === id) ?? { id }, labels)).join(", ") })];
    }).join("; ");
}

/** Compact element badge with a count and the greatest severity. */
export function DiagnosticBadge({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  const context = useContext(DiagnosticLabelContext);
  const summary = summarizeDiagnostics(diagnostics);
  if (summary === null) return null;
  return <span className={`diagnostic-badge diagnostic--${summary.severity.toLowerCase()}`} role="img"
    aria-label={diagnosticCountLabel(diagnostics)} title={groupDiagnostics(diagnostics).map(group => [
      diagnosticMessage(group.diagnostic, context.catalog, context.model, context),
      group.diagnostic.code.startsWith("LINT_") ? diagnosticGroupContext(group, context.variants) : "",
    ].filter(Boolean).join("; ")).join("\n")}>
    <DiagnosticCounts diagnostics={diagnostics} />
  </span>;
}

/** Compiler messages next to a catalog or experiment field; warnings and errors remain distinguishable. */
export function DiagnosticMessages({ diagnostics = [], id }: { diagnostics?: readonly Diagnostic[]; id?: string }) {
  const context = useContext(DiagnosticLabelContext);
  const summary = summarizeDiagnostics(diagnostics);
  return <span className={`field-feedback${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}>
    {summary === null ? null : <HelpHint id={id}
      label={diagnosticCountLabel(diagnostics)}
      symbol={<DiagnosticSymbol severity={summary.severity} />}>
      <ul className="field-diagnostics">
        {groupDiagnostics(diagnostics).map((group, index) => { const { diagnostic } = group; return <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}
          role={diagnostic.severity === "ERROR" ? "alert" : "status"}>
          <span>{diagnosticMessage(diagnostic, context.catalog, context.model, context)}</span>
          {diagnostic.code.startsWith("LINT_") ? <span className="diagnostic-context">{diagnosticGroupContext(group, context.variants)}</span> : null}
          {diagnostic.code.startsWith("LINT_") ? <LintDetails diagnostic={diagnostic} /> : <code className="diagnostic-code">{diagnostic.code}</code>}
        </li>; })}
      </ul>
    </HelpHint>}
  </span>;
}


/** Model-page summary of findings that belong to variant pages. */
export function VariantDiagnosticBadge({ diagnostics = [], onOpen, disabled = false }: {
  diagnostics?: readonly Diagnostic[]; onOpen?: () => void; disabled?: boolean;
}) {
  const labels = useContext(DiagnosticLabelContext).variants;
  const summary = summarizeDiagnostics(diagnostics);
  if (summary === null) return null;
  const label = variantDiagnosticLabel(diagnostics, labels);
  return <button type="button" className={`diagnostic-badge diagnostic-badge--variants diagnostic--${summary.severity.toLowerCase()} nodrag nopan nokey`}
    title={label} aria-label={label} disabled={disabled} onClick={event => { event.stopPropagation(); onOpen?.(); }}>
    <DiagnosticCounts diagnostics={diagnostics} />
  </button>;
}

/** Variant findings and links to their editable fields. */
export function VariantDiagnosticLinks({ diagnostics = [], onSelect, disabled = false }: {
  diagnostics?: readonly Diagnostic[]; onSelect?: (variant: string) => void; disabled?: boolean;
}) {
  const context = useContext(DiagnosticLabelContext);
  const labels = context.variants;
  const name = (id: string) => variantLabel(labels.find(variant => variant.id === id) ?? { id }, labels);
  const variants = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.variant != null) variants.set(diagnostic.variant, [...(variants.get(diagnostic.variant) ?? []), diagnostic]);
  }
  const summary = summarizeDiagnostics([...variants.values()].flat());
  return <span className={`field-feedback field-feedback--variants${summary === null ? "" : ` diagnostic--${summary.severity.toLowerCase()}`}`}>
    {summary === null ? null : <HelpHint interactive
      label={variantDiagnosticLabel(diagnostics, labels)}
      symbol={<DiagnosticSymbol severity={summary.severity} />}>
    {[...variants].map(([variant, findings]) => {
    const counts = (["ERROR", "WARNING", "ADVICE"] as const).flatMap(severity => {
      const count = groupDiagnostics(findings.filter(finding => finding.severity === severity)).length;
      return count === 0 ? [] : [t(`editor.diagnostics.variantCount.${severity}.${count === 1 ? "one" : "other"}`, { count: formatNumber(count) })];
    });
    return <div key={variant}><p className="variant-diagnostic-hint">
      <a href={`#variant-${encodeURIComponent(variant)}`} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
        onClick={event => { event.preventDefault(); if (!disabled) onSelect?.(variant); }}>
        {t("editor.diagnostics.inVariants", { variant: name(variant), counts: counts.join(", ") })}
      </a>
    </p><ul className="field-diagnostics">
      {groupDiagnostics(findings).map((group, index) => <li key={index} className={`diagnostic--${group.diagnostic.severity.toLowerCase()}`}>
        {diagnosticMessage(group.diagnostic, context.catalog, context.model, context)}
        {group.diagnostic.code.startsWith("LINT_") ? <span className="diagnostic-context">{diagnosticGroupContext(group, labels)}</span> : null}
      </li>)}
    </ul></div>;
    })}
    </HelpHint>}
  </span>;
}
