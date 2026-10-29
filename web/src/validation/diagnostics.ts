import { t } from "../i18n";
import type { ApiProblem, Diagnostic } from "../api/apiTypes";
import type { LoadedExperiment } from "../workspace/editor";
import { elementOf } from "../workspace/params";

/** Stable identity across validation and launch responses, including variant and document origin. */
export function diagnosticKey(diagnostic: Diagnostic): string {
  return JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.document ?? null,
    diagnostic.pointer ?? null, diagnostic.path ?? null, diagnostic.variant ?? null]);
}

/** Preserve response order and count findings repeated by validation and launch only once. */
export function mergeDiagnostics(...groups: (readonly Diagnostic[])[]): Diagnostic[] {
  return [...new Map(groups.flat().map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])).values()];
}

/** A transport or launch failure without compiler diagnostics still counts as one visible error. */
export function problemDiagnostics(problem: ApiProblem | null): readonly Diagnostic[] {
  if (problem === null) return [];
  return problem.diagnostics.length > 0 ? problem.diagnostics : [{
    code: problem.code, message: problem.message, ...(problem.args === undefined ? {} : { args: problem.args }), severity: "ERROR", document: null, pointer: null, path: null,
  }];
}

/** Human-readable document location shared by API and validation problem lists. */
export function locationOf(diagnostic: Diagnostic): string {
  const location = [diagnostic.document, diagnostic.pointer].filter((part) => part != null && part !== "").join("#") || t("common.experiment");
  return diagnostic.variant == null ? location : t("common.variantLocation", { variant: diagnostic.variant, location });
}

export interface DiagnosticTarget {
  element: string | null;
  /** Dotted catalog parameter, or an execution/fault field for the run settings. */
  field: string | null;
  variant: string | null;
}

/** Resolves compiler JSON Pointers (RFC 6901), including variant override origins, against this document snapshot. */
export function diagnosticTarget(
  diagnostic: Diagnostic,
  documents: Pick<LoadedExperiment, "model" | "modelPath" | "experiment" | "experimentPath">,
): DiagnosticTarget {
  const target: DiagnosticTarget = { element: null, field: null, variant: null };
  if (diagnostic.document != null && diagnostic.document !== documents.modelPath && diagnostic.document !== documents.experimentPath) return target;
  target.variant = diagnostic.variant ?? null;
  const tokens = (diagnostic.pointer ?? "").split("/").slice(1).map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const existingElement = (id: string | null | undefined) => id != null && elementOf(documents.model, id) !== null ? id : null;
  target.element = existingElement(diagnostic.path);
  if (diagnostic.document === documents.modelPath) {
    if (tokens[0] === "blocks") target.element ??= existingElement(tokens[1]);
    if (tokens[0] === "connections") target.element ??= existingElement(documents.model.connections[Number(tokens[1])]?.id);
    if (target.element !== null && tokens[2] === "params") target.field = tokens.slice(3).join(".") || null;
  } else if (diagnostic.document === documents.experimentPath) {
    if (tokens[0] === "variants") {
      if (diagnostic.variant === undefined) target.variant = documents.experiment.variants[Number(tokens[1])]?.id ?? null;
      if (tokens[2] === "id" || tokens[2] === "label") target.field = `variant.${tokens[2]}`;
      if (tokens[2] === "overrides" && tokens[3] !== undefined) {
        const [element, ...parameter] = tokens[3].split(".");
        target.element ??= existingElement(element);
        target.field = [...parameter, ...tokens.slice(4)].join(".") || null;
      }
    } else if (tokens[0] === "execution" || tokens[0] === "faults" || tokens[0] === "grid") {
      target.field = tokens.join(".");
    }
  }
  return target;
}

/** Badge count and greatest severity; warnings alone never block running. */
export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]) {
  return diagnostics.length === 0 ? null : {
    count: diagnostics.length,
    severity: diagnostics.some((diagnostic) => diagnostic.severity === "ERROR") ? "ERROR" as const : "WARNING" as const,
  };
}
