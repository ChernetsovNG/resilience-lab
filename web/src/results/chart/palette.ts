import type { ChartColorBy, ChartSeries } from "./types";

const colors = ["#2563eb", "#b45309", "#047857", "#9333ea", "#be123c", "#0e7490", "#475569", "#ca8a04", "#db2777", "#65a30d"];

export const chartColors = {
  warmup: "#94a3b8", fault: "#f59e0b", threshold: "#b91c1c",
  circuitOpenShare: "#b91c1c", ejectedShare: "#b45309", notReadyShare: "#475569",
  cursor: "#111827", hover: "#475569", grid: "#e4e7eb",
};

/** Identity hashing makes adding, hiding or reordering series independent of existing colors. */
function colorIndex(key: string): number {
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return hash % colors.length;
}

export function colorForKey(key: string): string {
  return colors[colorIndex(key)];
}

/** Variants use their position in the experiment, never their position among visible series. */
export function seriesColor(series: Pick<ChartSeries, "elementId" | "outputId" | "variantIndex">, mode: ChartColorBy): string {
  return mode === "variant" ? colors[(series.variantIndex ?? 0) % colors.length]
    : colorForKey(mode === "metric" ? series.outputId ?? "" : series.elementId ?? "");
}

function colorKey(color: string): string {
  const style = document.createElement("span").style;
  style.color = color;
  return style.color || color;
}

/** Stable IDs settle collisions deterministically; free preferred colors keep their assignment. */
function assignColors<T extends { id: string }>(series: readonly T[], preferred: (line: T) => string, occupied: readonly string[] = []) {
  const assigned = new Map<string, string>(), used = new Set(occupied.map(colorKey));
  for (const line of [...series].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    const first = preferred(line), start = colors.indexOf(first);
    let color = first;
    for (let offset = 1; used.has(colorKey(color)) && offset <= colors.length; offset++) color = colors[(start + offset) % colors.length];
    assigned.set(line.id, used.has(colorKey(color)) ? first : color);
    used.add(colorKey(assigned.get(line.id)!));
  }
  return assigned;
}

/** Automatic series avoid collisions; variant grouping and explicit style overrides keep their colors. */
export function chartSeriesColors(series: readonly Pick<ChartSeries, "id" | "color" | "elementId" | "outputId" | "variantIndex">[], mode: ChartColorBy) {
  if (mode === "variant") return new Map(series.map(line => [line.id, line.color ?? seriesColor(line, mode)]));
  const assigned = assignColors(series.filter(line => line.color === undefined), line => seriesColor(line, mode),
    series.flatMap(line => line.color === undefined ? [] : [line.color]));
  for (const line of series) if (line.color !== undefined) assigned.set(line.id, line.color);
  return assigned;
}

/** Timeline key colors are preferences; all visible series share the available palette. */
export function timelineSeriesColors(series: readonly { id: string; color: string }[]) {
  return assignColors(series, line => line.color);
}

/** Timeline keeps its element/metric coloring and distinguishes the comparison with a second color. */
export function timelineColor(elementId: string, outputId: string, comparison: boolean): string {
  // Disjoint preferred palettes distinguish variants while keeping separate element/metric colors.
  return colors[(colorIndex(JSON.stringify([elementId, outputId])) % (colors.length / 2)) * 2 + Number(comparison)];
}
