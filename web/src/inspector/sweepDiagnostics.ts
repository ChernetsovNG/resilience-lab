import type { Catalog, Diagnostic, ExperimentFile, ModelFile } from "../api/apiTypes";
import { t } from "../i18n";
import { formatParameterValue } from "../workspace/parameterValues";
import { diagnosticMessage, parameterLabel, pointLabel, variantLabel, type NamedVariant } from "../presentation/labels";

function pointValues(points: string, grid: NonNullable<ExperimentFile["grid"]>, labels: ReadonlyMap<string, string>): string {
  const ids = [...new Set(points.split(",").map(point => point.trim()))];
  const total = grid.reduce((product, axis) => product * axis.values.length, 1);
  if (grid.length === 0 || ids.some(id => !/^p(?:0|[1-9]\d*)$/.test(id) || !Number.isSafeInteger(Number(id.slice(1))) || Number(id.slice(1)) >= total)) {
    return ids.map(id => pointLabel(id, grid)).join(", ");
  }
  const coordinates = ids.map(id => {
    let index = Number(id.slice(1));
    return grid.map((_, axis) => {
      const stride = grid.slice(axis + 1).reduce((product, next) => product * next.values.length, 1);
      const coordinate = Math.floor(index / stride);
      index %= stride;
      return coordinate;
    });
  });
  const selected = grid.map((_, axis) => [...new Set(coordinates.map(point => point[axis]))]);
  const value = (axis: number, positions: number[]) => t("editor.grid.coordinate", {
    parameter: labels.get(grid[axis].path) ?? parameterLabel(grid[axis].path),
    value: positions.map(position => formatParameterValue(grid[axis].values[position])).join(", "),
  });
  // Omit an unconstrained axis only when the selected points form a complete Cartesian product.
  if (ids.length === selected.reduce((product, positions) => product * positions.length, 1)) {
    const restricted = selected.flatMap((positions, axis) => positions.length < grid[axis].values.length ? [value(axis, positions)] : []);
    if (restricted.length > 0) return restricted.join(", ");
  }
  return coordinates.map(point => point.map((position, axis) => value(axis, [position])).join(", ")).join("; ");
}

/** Group only sweep display rows; validation identities, counts and navigation retain their original diagnostics. */
export function sweepDiagnostics(diagnostics: readonly Diagnostic[], experiment: Pick<ExperimentFile, "grid"> & { variants: readonly NamedVariant[] },
  labels: ReadonlyMap<string, string>, catalog?: Catalog | null, model?: ModelFile | null): Diagnostic[] {
  const groups = new Map<string, { diagnostic: Diagnostic; variants: Set<string> }>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.document, diagnostic.pointer,
      diagnostic.path, diagnostic.variant == null, Object.entries(diagnostic.args ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { diagnostic, variants: new Set() };
      groups.set(key, group);
    }
    if (diagnostic.variant != null) group.variants.add(diagnostic.variant);
  }
  return [...groups.values()].map(({ diagnostic, variants }) => {
    const legacyPoints = /\s*\(points:\s*(p\d+(?:,\s*p\d+)*)\)\s*$/.exec(diagnostic.message);
    const points = diagnostic.args?.points ?? legacyPoints?.[1];
    const args = diagnostic.args == null ? diagnostic.args : { ...diagnostic.args };
    let fallback = diagnostic.message;
    if (typeof points === "string") {
      if (args != null) delete args.points;
      const suffix = ` (points: ${points})`;
      if (fallback.endsWith(suffix)) fallback = fallback.slice(0, -suffix.length);
      else if (legacyPoints !== null) fallback = fallback.slice(0, legacyPoints.index);
    }
    if (args !== undefined && args !== null) {
      if (typeof args.variant === "string") args.variant = variantLabel(experiment.variants.find(variant => variant.id === args.variant) ?? { id: args.variant }, experiment.variants);
      if (typeof args.point === "string") args.point = pointValues(args.point, experiment.grid ?? [], labels);
    }
    let message = diagnosticMessage({ ...diagnostic, message: fallback, args }, catalog, model);
    for (const [path, title] of labels) message = message.replaceAll(path, title);
    if (typeof points === "string") message = t("editor.grid.atPoints", { message, points: pointValues(points, experiment.grid ?? [], labels) });
    if (variants.size > 0) message = t("editor.grid.inVariants", { message, variants: [...variants]
      .map(id => variantLabel(experiment.variants.find(variant => variant.id === id) ?? { id }, experiment.variants)).join(", ") });
    return { ...diagnostic, args: undefined, message };
  });
}
