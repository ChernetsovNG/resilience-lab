import type { components } from "../../api/schema";

type SeriesIndex = components["schemas"]["SeriesIndex"];
type SeriesPartReference = components["schemas"]["SeriesPartReference"];

/** Selects only parts intersecting the requested elements and half-open window range. */
export function selectSeriesParts(
  index: SeriesIndex,
  nodes: readonly string[],
  fromWindow: number,
  untilWindow: number,
  connections: readonly string[] = [],
  classes: readonly string[] = [],
): SeriesPartReference[] {
  if (fromWindow >= untilWindow) return [];
  const requested = new Set(nodes);
  const requestedConnections = new Set(connections);
  const requestedClasses = new Set(classes);
  return index.parts.filter((part) =>
    part.fromWindow < untilWindow && fromWindow < part.untilWindow && (part.nodes.some((node) => requested.has(node))
      || part.connections.some((id) => requestedConnections.has(id)) || part.classes.some(id => requestedClasses.has(id))),
  );
}
