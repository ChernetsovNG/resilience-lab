import type { ChartColorBy, ChartSeries } from "./types";

const colors = ["#2563eb", "#b45309", "#047857", "#9333ea", "#be123c", "#0e7490"];

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

/** Timeline keeps its element/metric coloring and distinguishes the comparison with a second color. */
export function timelineColor(elementId: string, outputId: string, comparison: boolean): string {
  // Disjoint palettes distinguish variants while keeping separate element/metric colors.
  return colors[(colorIndex(JSON.stringify([elementId, outputId])) % (colors.length / 2)) * 2 + Number(comparison)];
}
