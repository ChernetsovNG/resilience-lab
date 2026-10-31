import type { Catalog, Diagnostic, ModelFile, RunSummary } from "../api/apiTypes";
import { messages, t } from "../i18n";
import { catalogText, localizeCatalog } from "../i18n/catalog";
import { formatNumber } from "../i18n/format";
import { catalogParameter, formatParameterValue } from "../workspace/parameterValues";
import { backendMessage } from "../i18n/backendMessage";
import type { DiagnosticGroup } from "../validation/diagnostics";

export interface NamedVariant { id: string; label?: string | null }
type GridAxis = RunSummary["grid"][number];
export interface DiagnosticPresentationContext {
  variants: readonly NamedVariant[];
  grid?: readonly GridAxis[];
  catalog?: Catalog | null;
  model?: ModelFile | null;
}
type DiagnosticText = Pick<Diagnostic, "code" | "message" | "args" | "path"> & { requiresNewRun?: boolean };

/** Connection endpoints identify the path; the original id distinguishes parallel connections and replica copies. */
export function elementLabel(id: string, model?: Pick<ModelFile, "connections"> | null): string {
  const replica = /^(.*)(#[1-9][0-9]*)$/.exec(id);
  const connection = model?.connections.find(connection => connection.id === (replica?.[1] ?? id));
  return connection === undefined ? id : `${t("editor.grid.connection", { from: connection.from + (replica?.[2] ?? ""), to: connection.to })} (${id})`;
}

/** Meaningful summary labels win; source documents distinguish explicit labels from generated fallbacks. */
export function variantLabel(variant: NamedVariant | undefined, variants: readonly NamedVariant[] = []): string {
  if (variant === undefined) return t("results.variant");
  const id = variant.id;
  const source = variants.find(candidate => candidate.id === id);
  if (source !== undefined && "overrides" in source && (!variant.label?.trim() || variant.label === variant.id)) variant = source;
  const generated = /^variant-(\d+)$/.exec(variant.id);
  if (variant.label?.trim() && (variant.label !== variant.id || "overrides" in variant || (!generated && variant.id !== "baseline"))) return variant.label;
  if (variant.id === "baseline") return t("file.baseline");
  const index = variants.findIndex(candidate => candidate.id === id);
  const number = generated === null ? index < 0 ? null : index + 1 : Number(generated[1]);
  return number === null ? t("results.variant") : t("editor.variant.newLabel", { number: formatNumber(number) });
}

/** List the affected replicas and named variants without exposing expanded instance identifiers. */
export function diagnosticGroupContext(group: DiagnosticGroup, variants: readonly NamedVariant[]): string {
  const replicas = [...new Set(group.members.flatMap(item => typeof item.args?.replica === "number" ? [item.args.replica] : []))].sort((a, b) => a - b);
  const ranges: number[][] = [];
  for (const replica of replicas) {
    const last = ranges.at(-1);
    if (last !== undefined && last.at(-1)! + 1 === replica) last.push(replica);
    else ranges.push([replica]);
  }
  const ids = [...new Set(group.members.flatMap(item => item.variant == null ? variants.map(variant => variant.id) : [item.variant]))];
  return [
    ranges.length === 0 ? "" : t("results.problems.replicas", { replicas: ranges.map(range =>
      range.length === 1 ? `#${formatNumber(range[0])}` : `#${formatNumber(range[0])}–#${formatNumber(range.at(-1)!)}`).join(", ") }),
    ids.length === 0 ? "" : t("results.problems.variants", { variants: ids.map(id =>
      variantLabel(variants.find(variant => variant.id === id) ?? { id }, variants)).join(", ") }),
  ].filter(Boolean).join("; ");
}

/** Resolve parameter titles from the catalog; stored results remain readable without their documents. */
export function parameterLabel(path: string, catalog?: Catalog | null, model?: ModelFile | null): string {
  const [id, ...fields] = path.split(".");
  if (fields.length === 0) return id;
  const element = model?.blocks[id] ?? model?.connections.find(connection => connection.id === id);
  const parameter = catalog == null || element === undefined ? undefined
    : catalogParameter(localizeCatalog(catalog), element.type, element.params, fields.join("."));
  const title = parameter?.title ?? fields.map((field, index) => {
    const suffix = `.params.${fields.slice(0, index + 1).join(".")}.title`;
    const titles = [...new Set(Object.entries(messages).filter(([key]) => key.startsWith("catalog.types.") && key.endsWith(suffix)).map(([, value]) => value))];
    const fallback = titles[0] ?? field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
    return element === undefined ? fallback : catalogText(`catalog.types.${element.type}${suffix}`, fallback);
  }).join(t("editor.symbols.separator"));
  return t("editor.grid.axisTitle", { parameter: title,
    element: element !== undefined && "from" in element ? t("editor.grid.connection", { from: element.from, to: element.to }) : id });
}

/** Translate parameter and task arguments at display time, retaining the original identities for navigation. */
export function diagnosticMessage(diagnostic: DiagnosticText, catalog?: Catalog | null, model?: ModelFile | null,
  context?: Pick<DiagnosticPresentationContext, "variants" | "grid">): string {
  if (diagnostic.args == null) return backendMessage(diagnostic);
  const args = { ...diagnostic.args };
  for (const key of ["connection", "target"]) {
    if (typeof args[key] === "string") args[key] = elementLabel(args[key], model);
  }
  const parameter = args.parameter;
  if (typeof parameter === "string" && diagnostic.path != null) {
    const root = parameter.split(".")[0];
    const full = parameter.startsWith(`${diagnostic.path}.`) || model?.blocks[root] !== undefined
      || model?.connections.some(connection => connection.id === root);
    args.parameter = parameterLabel(full ? parameter : `${diagnostic.path}.${parameter}`, catalog, model);
  }
  if (context !== undefined) {
    const point = (id: string) => pointLabel(id, context.grid ?? [], undefined, catalog, model);
    if (typeof args.points === "string") args.points = args.points.split(",").map(id => point(id.trim())).join("; ");
    if (typeof args.point === "string") args.point = point(args.point);
    if (typeof args.variant === "string") args.variant = variantLabel(context.variants.find(variant => variant.id === args.variant)
      ?? { id: args.variant }, context.variants);
  }
  return backendMessage({ ...diagnostic, args });
}

/** Decode the saved grid order only when the artifact did not include explicit coordinates. */
export function pointCoordinates(pointId: string, grid: readonly GridAxis[]): Record<string, unknown> {
  if (!/^p(?:0|[1-9]\d*)$/.test(pointId)) return {};
  let index = Number(pointId.slice(1));
  const count = grid.reduce((total, axis) => total * axis.values.length, 1);
  if (!Number.isSafeInteger(index) || index >= count || grid.length === 0) return {};
  return Object.fromEntries(grid.map((axis, position) => {
    const stride = grid.slice(position + 1).reduce((total, next) => total * next.values.length, 1);
    const value = axis.values[Math.floor(index / stride)];
    index %= stride;
    return [axis.path, value];
  }));
}

/** A point is identified to readers by its actual axis values, never its storage ID. */
export function pointLabel(pointId: string, grid: readonly GridAxis[], coordinates?: Readonly<Record<string, unknown>>,
  catalog?: Catalog | null, model?: ModelFile | null): string {
  const values = coordinates !== undefined && Object.keys(coordinates).length > 0 ? coordinates : pointCoordinates(pointId, grid);
  const label = Object.entries(values).map(([path, value]) => t("results.coordinate", {
    path: parameterLabel(path, catalog, model), value: formatParameterValue(value),
  })).join(t("results.coordinateSeparator"));
  const number = /^p\d+$/.test(pointId) ? Number(pointId.slice(1)) + 1 : null;
  return label || (number !== null && Number.isSafeInteger(number) ? `${t("results.point")} ${formatNumber(number)}` : t("results.point"));
}
