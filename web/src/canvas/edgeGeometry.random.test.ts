import { expect, it } from "vitest";
import type { Rect, XYPosition } from "@xyflow/react";
import { legacyCorridor } from "../test/legacyEdgeGeometry";
import { corridor, layoutEdges, type EdgeLayoutInput } from "./edgeGeometry";

const epsilon = 1e-7;
const overlaps = (a: Rect, b: Rect) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + epsilon &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + epsilon;
const length = (points: XYPosition[]) => points.slice(1).reduce((sum, end, index) =>
  sum + Math.hypot(end.x - points[index].x, end.y - points[index].y), 0);

function crosses(points: XYPosition[], rect: Rect) {
  return points.slice(1).some((end, index) => {
    const start = points[index];
    return start.y === end.y
      ? start.y > rect.y + epsilon && start.y < rect.y + rect.height - epsilon &&
        Math.max(start.x, end.x) > rect.x + epsilon && Math.min(start.x, end.x) < rect.x + rect.width - epsilon
      : start.x > rect.x + epsilon && start.x < rect.x + rect.width - epsilon &&
        Math.max(start.y, end.y) > rect.y + epsilon && Math.min(start.y, end.y) < rect.y + rect.height - epsilon;
  });
}

it("preserves corridor lengths on identical obstacles and safe deterministic layouts on seeded random diagrams", () => {
  let seed = 338;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let trial = 0; trial < 50; trial++) {
    const nodes = new Map<string, Rect>();
    for (let index = 0; index < 6; index++) {
      let rect: Rect;
      do {
        rect = { x: Math.round(random() * 12000) / 10 - 200, y: Math.round(random() * 7000) / 10 - 100,
          width: 180, height: 120 };
      } while ([...nodes.values()].some(node => overlaps({ x: rect.x - 20, y: rect.y - 20, width: 220, height: 160 }, node)));
      nodes.set(String(index), rect);
    }
    const edges: EdgeLayoutInput[] = Array.from({ length: 8 }, (_, index) => {
      const from = String(Math.floor(random() * nodes.size));
      let to: string;
      do { to = String(Math.floor(random() * nodes.size)); } while (to === from);
      const source = nodes.get(from)!;
      const target = nodes.get(to)!;
      return { id: String(index), from, to, sourceX: source.x + source.width, sourceY: source.y + source.height / 2,
        targetX: target.x, targetY: target.y + target.height / 2, width: 90, height: 24 };
    });
    const actual = layoutEdges(edges, nodes);
    const repeated = layoutEdges(structuredClone(edges), structuredClone(nodes));
    expect(JSON.stringify([...repeated]), `diagram ${trial}`).toBe(JSON.stringify([...actual]));
    const labels = edges.map(edge => {
      const { label } = actual.get(edge.id)!;
      return { id: edge.id, x: label.x - edge.width / 2, y: label.y - edge.height / 2, width: edge.width, height: edge.height };
    });
    for (const edge of edges) {
      const { points } = actual.get(edge.id)!;
      const context = `diagram ${trial}, edge ${edge.id}`;
      const obstacles = [...nodes.values(), ...labels.filter(label => label.id !== edge.id)];
      const start = { x: edge.sourceX + 1, y: edge.sourceY };
      const end = { x: edge.targetX - 1, y: edge.targetY };
      expect(length(corridor(start, end, obstacles)), context).toBeCloseTo(length(legacyCorridor(start, end, obstacles)), 6);
      expect(points[0], context).toEqual({ x: edge.sourceX, y: edge.sourceY });
      expect(points.at(-1), context).toEqual({ x: edge.targetX, y: edge.targetY });
      expect(points.slice(1).every((point, index) => point.x === points[index].x || point.y === points[index].y), context).toBe(true);
      for (const [id, node] of nodes) {
        if (id !== edge.from && id !== edge.to) expect(crosses(points, node), `${context}, node ${id}`).toBe(false);
      }
      for (const label of labels) if (label.id !== edge.id) expect(crosses(points, label), `${context}, label ${label.id}`).toBe(false);
    }
    labels.forEach((label, index) => {
      expect([...nodes.values()].some(node => overlaps(label, node)), `diagram ${trial}, label ${label.id}`).toBe(false);
      expect(labels.slice(index + 1).some(other => overlaps(label, other)), `diagram ${trial}, label ${label.id}`).toBe(false);
    });
  }
});
