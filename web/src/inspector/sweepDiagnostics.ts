import type { Diagnostic, ExperimentFile } from "../api/apiTypes";
import { t } from "../i18n";
import { backendMessage } from "../i18n/backendMessage";
import { formatParameterValue } from "../workspace/parameterValues";

function pointValues(points: string, grid: NonNullable<ExperimentFile["grid"]>, labels: ReadonlyMap<string, string>): string {
  const ids = [...new Set(points.split(",").map(point => point.trim()))];
  const total = grid.reduce((product, axis) => product * axis.values.length, 1);
  if (grid.length === 0 || ids.some(id => !/^p(?:0|[1-9]\d*)$/.test(id) || !Number.isSafeInteger(Number(id.slice(1))) || Number(id.slice(1)) >= total)) return points;
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
    parameter: labels.get(grid[axis].path) ?? grid[axis].path,
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
export function sweepDiagnostics(diagnostics: readonly Diagnostic[], experiment: ExperimentFile, labels: ReadonlyMap<string, string>): Diagnostic[] {
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
    const points = diagnostic.args?.points;
    const args = diagnostic.args == null ? diagnostic.args : { ...diagnostic.args };
    let fallback = diagnostic.message;
    if (typeof points === "string") {
      delete args!.points;
      const suffix = ` (points: ${points})`;
      if (fallback.endsWith(suffix)) fallback = fallback.slice(0, -suffix.length);
    }
    let message = backendMessage({ ...diagnostic, message: fallback, args });
    if (typeof points === "string") message = t("editor.grid.atPoints", { message, points: pointValues(points, experiment.grid ?? [], labels) });
    if (variants.size > 0) message = t("editor.grid.inVariants", { message, variants: [...variants]
      .map(id => experiment.variants.find(variant => variant.id === id)?.label || id).join(", ") });
    return { ...diagnostic, args: undefined, message };
  });
}
