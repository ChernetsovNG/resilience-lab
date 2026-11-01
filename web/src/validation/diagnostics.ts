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

export interface DiagnosticGroup {
  /** Normalized display value; navigation always uses an original member. */
  diagnostic: Diagnostic;
  members: Diagnostic[];
}

const severityOrder = { ERROR: 0, WARNING: 1, ADVICE: 2 };

/** Collapse equivalent structured lint findings, preserving source locations and ordering groups by severity. */
export function groupDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticGroup>();
  return diagnostics.flatMap((original, index) => {
    const lint = original.severity !== "ERROR" && original.code.startsWith("LINT_") && original.args != null;
    const args = { ...original.args };
    const replica = typeof args.replica === "number" ? args.replica : null;
    const base = (path: string) => replica === null ? path : path.replace(/#\d+$/, "");
    delete args.replica;
    for (const name of ["service", "connection"]) if (typeof args[name] === "string") args[name] = base(args[name]);
    const diagnostic = lint ? { ...original, path: original.path == null ? original.path : base(original.path), args } : original;
    const key = lint ? JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.path ?? null,
      Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]) : String(index);
    const existing = groups.get(key);
    if (existing !== undefined) { existing.members.push(original); return []; }
    const group = { diagnostic, members: [original] };
    groups.set(key, group);
    return [group];
  }).sort((left, right) => severityOrder[left.diagnostic.severity] - severityOrder[right.diagnostic.severity]);
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
    if (target.element !== null && (tokens[2] === "scenario" || tokens[2] === "replicaOverrides" || tokens[2] === "classes")) target.field = tokens.slice(2).join(".");
    if (target.element !== null && diagnostic.code === "SCENARIO_REQUIRED") target.field = "scenario";
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
    count: groupDiagnostics(diagnostics).length,
    severity: diagnostics.some((diagnostic) => diagnostic.severity === "ERROR") ? "ERROR" as const
      : diagnostics.some((diagnostic) => diagnostic.severity === "WARNING") ? "WARNING" as const : "ADVICE" as const,
  };
}
