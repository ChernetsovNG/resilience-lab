import { describe, expect, it } from "vitest";
import type { Rect, XYPosition } from "@xyflow/react";
import { layoutEdges, type EdgeLayoutInput } from "./edgeGeometry";

const nodes = new Map<string, Rect>([
  ["gateway", { x: 0, y: 100, width: 180, height: 80 }],
  ["middle", { x: 340, y: 100, width: 180, height: 80 }],
  ["dependency", { x: 680, y: 100, width: 180, height: 80 }],
]);
const bypass: EdgeLayoutInput = { id: "bypass", from: "gateway", to: "dependency",
  sourceX: 180, sourceY: 140, targetX: 680, targetY: 140, width: 100, height: 30 };

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function crosses(points: XYPosition[], rect: Rect) {
  return points.slice(1).some((end, index) => {
    const start = points[index];
    return start.y === end.y
      ? start.y > rect.y && start.y < rect.y + rect.height && Math.max(start.x, end.x) > rect.x && Math.min(start.x, end.x) < rect.x + rect.width
      : start.x > rect.x && start.x < rect.x + rect.width && Math.max(start.y, end.y) > rect.y && Math.min(start.y, end.y) < rect.y + rect.height;
  });
}

describe("edge geometry", () => {
  it("routes through free corridors while keeping the actual ports", () => {
    const route = layoutEdges([bypass], nodes).get("bypass")!;
    expect(route.points[0]).toEqual({ x: 180, y: 140 });
    expect(route.points.at(-1)).toEqual({ x: 680, y: 140 });
    expect(crosses(route.points, nodes.get("middle")!)).toBe(false);
  });

  it("uses narrow gaps without crossing a nearby foreign node", () => {
    const bounds = new Map(nodes);
    bounds.set("middle", { x: 190, y: 100, width: 180, height: 80 });
    bounds.set("dependency", { x: 390, y: 100, width: 180, height: 80 });
    const route = layoutEdges([{ ...bypass, targetX: 390 }], bounds).get("bypass")!;
    expect(crosses(route.points, bounds.get("middle")!)).toBe(false);
    expect(route.points.slice(1).every((point, index) => point.x === route.points[index].x || point.y === route.points[index].y)).toBe(true);
  });

  it("routes fractional clearances from a negative node origin", () => {
    const bounds = new Map<string, Rect>([
      ["source", { x: -5, y: 100, width: 111, height: 80 }],
      ["middle", { x: 116, y: 100, width: 180, height: 80 }],
      ["target", { x: 336, y: 100, width: 180, height: 80 }],
    ]);
    const route = layoutEdges([{ ...bypass, from: "source", to: "target", sourceX: 106, targetX: 336 }], bounds).get("bypass")!;
    expect(crosses(route.points, bounds.get("middle")!)).toBe(false);
    expect(route.points.slice(1).every((point, index) => point.x === route.points[index].x || point.y === route.points[index].y)).toBe(true);
  });

  it("keeps a detour label on the path when adjacent segments reverse direction", () => {
    const bounds = new Map<string, Rect>([
      ["n0", { x: 600, y: 400, width: 180, height: 80 }],
      ["n1", { x: 0, y: 200, width: 180, height: 80 }],
      ["n2", { x: 1200, y: 200, width: 180, height: 80 }],
    ]);
    const route = layoutEdges([
      { ...bypass, id: "e0", from: "n1", to: "n2", sourceX: 180, sourceY: 240, targetX: 1200, targetY: 240, width: 600, height: 90 },
      { ...bypass, id: "e1", from: "n0", to: "n2", sourceX: 780, sourceY: 440, targetX: 1200, targetY: 240, width: 300, height: 90 },
      { ...bypass, id: "e2", from: "n0", to: "n2", sourceX: 780, sourceY: 440, targetX: 1200, targetY: 240, width: 80, height: 90 },
    ], bounds).get("e2")!;
    expect(route.points.slice(1).some((end, index) => {
      const start = route.points[index];
      return route.label.x >= Math.min(start.x, end.x) && route.label.x <= Math.max(start.x, end.x) &&
        route.label.y >= Math.min(start.y, end.y) && route.label.y <= Math.max(start.y, end.y);
    })).toBe(true);
  });

  it("keeps the port corridor clear of a node touching a nearby corner", () => {
    const bounds = new Map(nodes);
    bounds.set("middle", { x: 180, y: 144, width: 180, height: 80 });
    bounds.set("dependency", { x: 680, y: 0, width: 180, height: 80 });
    const route = layoutEdges([{ ...bypass, targetY: 40 }], bounds).get("bypass")!;
    expect(crosses(route.points, bounds.get("middle")!)).toBe(false);
    expect(route.points.slice(1).every((point, index) => point.x === route.points[index].x || point.y === route.points[index].y)).toBe(true);
  });

  it("follows a shared boundary when a foreign node touches the source port", () => {
    const bounds = new Map<string, Rect>([
      ["source", { x: 420, y: -47, width: 109, height: 63 }],
      ["middle", { x: 529, y: -164, width: 139, height: 173 }],
      ["target", { x: 164, y: 40, width: 59, height: 72 }],
    ]);
    const route = layoutEdges([{ ...bypass, from: "source", to: "target", sourceX: 529, sourceY: -15.5,
      targetX: 164, targetY: 76 }], bounds).get("bypass")!;
    expect(crosses(route.points, bounds.get("middle")!)).toBe(false);
    expect(route.points.slice(1).every((point, index) => point.x === route.points[index].x || point.y === route.points[index].y)).toBe(true);
  });

  it("places the measured label on its path outside every node", () => {
    const route = layoutEdges([bypass], nodes).get("bypass")!;
    const label = { x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 };
    expect([...nodes.values()].filter(node => overlaps(label, node))).toEqual([]);
    expect(route.points.slice(1).some((end, index) => {
      const start = route.points[index];
      return route.label.x >= Math.min(start.x, end.x) && route.label.x <= Math.max(start.x, end.x) &&
        route.label.y >= Math.min(start.y, end.y) && route.label.y <= Math.max(start.y, end.y);
    })).toBe(true);
  });

  it("separates labels of two calls with identical ports", () => {
    const routes = [...layoutEdges([bypass, { ...bypass, id: "second" }], nodes).values()];
    const labels = routes.map(route => ({ x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 }));
    expect(overlaps(labels[0], labels[1])).toBe(false);
    for (const route of routes) expect(crosses(route.points, nodes.get("middle")!)).toBe(false);
    expect(crosses(routes[1].points, labels[0])).toBe(false);
  });

  it("keeps a target port reachable beside an already placed label", () => {
    const neighbor = { ...bypass, id: "neighbor", from: "middle", sourceX: 520, width: 120 };
    const route = layoutEdges([neighbor, bypass], nodes).get("bypass")!;
    expect(crosses(route.points, nodes.get("middle")!)).toBe(false);
    for (let index = 1; index < route.points.length; index++) {
      expect(route.points[index].x === route.points[index - 1].x || route.points[index].y === route.points[index - 1].y).toBe(true);
    }
  });

  it("uses an outer corridor when a large label cannot fit between nodes", () => {
    const route = layoutEdges([{ ...bypass, width: 900, height: 120 }], nodes).get("bypass")!;
    const label = { x: route.label.x - 450, y: route.label.y - 60, width: 900, height: 120 };
    expect([...nodes.values()].some(node => overlaps(label, node))).toBe(false);
    expect(crosses(route.points, nodes.get("middle")!)).toBe(false);
  });

  it("keeps the ends of a label detour outside the source footprint", () => {
    const bounds = new Map<string, Rect>([
      ["source", { x: 598, y: 408, width: 180, height: 80 }],
      ["target", { x: 999, y: 438, width: 180, height: 80 }],
      ["blocker", { x: 810, y: 447, width: 160, height: 80 }],
    ]);
    const route = layoutEdges([{ ...bypass, from: "source", to: "target", sourceX: 778, sourceY: 448,
      targetX: 999, targetY: 478, width: 190, height: 57 }], bounds).get("bypass")!;
    for (let index = 1; index < route.points.length; index++) {
      expect(route.points[index].x === route.points[index - 1].x || route.points[index].y === route.points[index - 1].y).toBe(true);
    }
  });

  it.each([[-420, 400], [1000, -240]])("routes backward and diagonal ports %s,%s", (x, y) => {
    const bounds = new Map(nodes);
    bounds.set("dependency", { x, y, width: 180, height: 80 });
    bounds.set("blocker", { x: 100, y: -120, width: 200, height: 80 });
    const edge = { ...bypass, targetX: x, targetY: y + 40 };
    const route = layoutEdges([edge], bounds).get("bypass")!;
    expect(route.points.at(-1)).toEqual({ x, y: y + 40 });
    for (const id of ["middle", "blocker"]) expect(crosses(route.points, bounds.get(id)!)).toBe(false);
    const label = { x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 };
    expect([...bounds.values()].some(node => overlaps(label, node))).toBe(false);
  });

  it("recomputes deterministically after a node or label changes size", () => {
    const bounds = new Map(nodes);
    bounds.set("middle", { x: 260, y: -200, width: 300, height: 420 });
    const edge = { ...bypass, width: 240, height: 75 };
    const route = layoutEdges([edge], bounds).get("bypass")!;
    expect(crosses(route.points, bounds.get("middle")!)).toBe(false);
    expect(route).toEqual(layoutEdges([edge], bounds).get("bypass"));
    expect(bounds.get("middle")).toEqual({ x: 260, y: -200, width: 300, height: 420 });
  });
});
