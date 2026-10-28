import type { Diagnostic } from "../api/apiTypes";
import type { LoadedExperiment } from "../workspace/editor";
import { elementOf } from "../workspace/params";

/** Human-readable document location shared by API and validation problem lists. */
export function locationOf(diagnostic: Diagnostic): string {
  return [diagnostic.document, diagnostic.pointer].filter((part) => part != null && part !== "").join("#") || "experiment";
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
  const tokens = (diagnostic.pointer ?? "").split("/").slice(1).map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const existingElement = (id: string | null | undefined) => id != null && elementOf(documents.model, id) !== null ? id : null;
  target.element = existingElement(diagnostic.path);
  if (diagnostic.document === documents.modelPath) {
    if (tokens[0] === "blocks") target.element ??= existingElement(tokens[1]);
    if (tokens[0] === "connections") target.element ??= existingElement(documents.model.connections[Number(tokens[1])]?.id);
    if (target.element !== null && tokens[2] === "params") target.field = tokens.slice(3).join(".") || null;
  } else if (diagnostic.document === documents.experimentPath) {
    if (tokens[0] === "variants") {
      target.variant = documents.experiment.variants[Number(tokens[1])]?.id ?? null;
      if (tokens[2] === "overrides" && tokens[3] !== undefined) {
        const [element, ...parameter] = tokens[3].split(".");
        target.element ??= existingElement(element);
        target.field = [...parameter, ...tokens.slice(4)].join(".") || null;
      }
    } else if (tokens[0] === "execution" || tokens[0] === "faults") {
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
