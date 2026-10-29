import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { Diagnostic } from "../api/apiTypes";
import { summarizeDiagnostics } from "./diagnostics";

/** Compact element badge with a count and the greatest severity. */
export function DiagnosticBadge({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  const summary = summarizeDiagnostics(diagnostics);
  if (summary === null) return null;
  return <span className={`diagnostic-badge diagnostic--${summary.severity.toLowerCase()}`} role="img"
    aria-label={t("editor.diagnostics.countLabel", { count: formatNumber(summary.count), severity: summary.severity.toLowerCase() })} title={diagnostics.map((item) => item.message).join("\n")}>
    {t("editor.diagnostics.badge", { symbol: summary.severity === "ERROR" ? t("editor.symbols.error") : t("editor.symbols.warning"), count: formatNumber(summary.count) })}
  </span>;
}

/** Compiler messages next to a catalog or experiment field; warnings and errors remain distinguishable. */
export function DiagnosticMessages({ diagnostics = [], id }: { diagnostics?: readonly Diagnostic[]; id?: string }) {
  if (diagnostics.length === 0) return null;
  return <ul id={id} className="field-diagnostics">
    {diagnostics.map((diagnostic, index) => <li key={index} className={`diagnostic--${diagnostic.severity.toLowerCase()}`}
      role={diagnostic.severity === "ERROR" ? "alert" : "status"}>
      {t("editor.diagnostics.message", { code: diagnostic.code, message: diagnostic.message })}
    </li>)}
  </ul>;
}
