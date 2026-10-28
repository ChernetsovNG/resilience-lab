import type { components } from "../../api/schema";

type SeriesIndex = components["schemas"]["SeriesIndex"];
type SeriesPartReference = components["schemas"]["SeriesPartReference"];

/** Selects only parts intersecting both the requested nodes and half-open window range. */
export function selectSeriesParts(
  index: SeriesIndex,
  nodes: readonly string[],
  fromWindow: number,
  untilWindow: number,
): SeriesPartReference[] {
  const requested = new Set(nodes);
  return index.parts.filter((part) =>
    part.fromWindow < untilWindow && fromWindow < part.untilWindow && part.nodes.some((node) => requested.has(node)),
  );
}
