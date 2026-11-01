import { describe, expect, it } from "vitest";
import type { Rect, XYPosition } from "@xyflow/react";
import { diagramBounds, layoutEdges, type EdgeLayoutInput } from "./edgeGeometry";
import { sharedEdgeLength } from "../test/sharedEdgeLength";

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
  it.each(["outgoing", "incoming"] as const)("separates two and three %s edges immediately at their shared port", direction => {
    for (const heights of [[0, 100], [100, 300], [0, 300], [0, 100, 300], [-280, -140, 0], [300, 460, 620]]) {
      const bounds = new Map<string, Rect>([["shared", { x: direction === "outgoing" ? 0 : 680, y: 100, width: 180, height: 80 }]]);
      const edges = heights.map((y, index): EdgeLayoutInput => {
        const id = `branch-${index}`;
        bounds.set(id, { x: direction === "outgoing" ? 680 : 0, y, width: 180, height: 80 });
        return { id, from: direction === "outgoing" ? "shared" : id, to: direction === "outgoing" ? id : "shared",
          sourceX: 180, sourceY: direction === "outgoing" ? 140 : y + 40,
          targetX: 680, targetY: direction === "outgoing" ? y + 40 : 140, width: 100, height: 30 };
      });
      const actual = layoutEdges(edges, bounds);
      expect(actual).toEqual(layoutEdges(structuredClone(edges), structuredClone(bounds)));
      const routes = [...actual.values()];
      const labels = routes.map(route => ({ x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 }));
      routes.forEach((route, index) => {
        for (const other of routes.slice(index + 1)) expect(sharedEdgeLength(route.points, other.points)).toBeLessThanOrEqual(12);
        expect(route.points.slice(1).every((point, segment) => point.x === route.points[segment].x || point.y === route.points[segment].y)).toBe(true);
        for (const node of bounds.values()) expect(crosses(route.points, node)).toBe(false);
        for (const [other, label] of labels.entries()) if (other !== index) expect(crosses(route.points, label)).toBe(false);
        expect(route.points.slice(1).some((end, segment) => {
          const start = route.points[segment];
          return route.label.x >= Math.min(start.x, end.x) && route.label.x <= Math.max(start.x, end.x) &&
            route.label.y >= Math.min(start.y, end.y) && route.label.y <= Math.max(start.y, end.y);
        })).toBe(true);
      });
    }
  });

  it("routes through free corridors while keeping the actual ports", () => {
    const route = layoutEdges([bypass], nodes).get("bypass")!;
    expect(route.points[0]).toEqual({ x: 180, y: 140 });
    expect(route.points.at(-1)).toEqual({ x: 680, y: 140 });
    expect(crosses(route.points, nodes.get("middle")!)).toBe(false);
  });

  it("limits the common stub when the measured handle sits inside the node footprint", () => {
    const edges = [bypass, { ...bypass, id: "second" }].map(edge => ({ ...edge, sourceX: 173.99989 }));
    const routes = [...layoutEdges(edges, nodes).values()];
    expect(sharedEdgeLength(routes[0].points, routes[1].points)).toBeLessThanOrEqual(12);
    for (const route of routes) expect(route.points[0]).toEqual({ x: 173.99989, y: 140 });
  });

  it("separates short coincident routes whose port allowances overlap", () => {
    const bounds = new Map<string, Rect>([
      ["source", { x: 0, y: 100, width: 180, height: 80 }],
      ["target", { x: 198, y: 100, width: 180, height: 80 }],
    ]);
    const edges = Array.from({ length: 3 }, (_, index) => ({ ...bypass, id: String(index), from: "source", to: "target",
      targetX: 198, width: 0, height: 0 }));
    const routes = [...layoutEdges(edges, bounds).values()];
    routes.forEach((route, index) => {
      for (const other of routes.slice(index + 1)) expect(sharedEdgeLength(route.points, other.points)).toBeLessThanOrEqual(12);
    });
  });

  it.each(["outgoing", "incoming"] as const)("keeps dense %s branches orthogonal with inset handles", direction => {
    for (const count of [4, 8]) {
      const bounds = new Map<string, Rect>([["shared", { x: direction === "outgoing" ? 0 : 680, y: 100, width: 180, height: 80 }]]);
      const edges = Array.from({ length: count }, (_, index): EdgeLayoutInput => {
        const id = `branch-${index}`;
        const y = 300 + index * 120;
        bounds.set(id, { x: direction === "outgoing" ? 680 : 0, y, width: 180, height: 80 });
        return { id, from: direction === "outgoing" ? "shared" : id, to: direction === "outgoing" ? id : "shared",
          sourceX: direction === "outgoing" ? 174 : 180, sourceY: direction === "outgoing" ? 140 : y + 40,
          targetX: direction === "outgoing" ? 680 : 686, targetY: direction === "outgoing" ? y + 40 : 140, width: 100, height: 30 };
      });
      const routes = [...layoutEdges(edges, bounds).values()];
      const labels = routes.map(route => ({ x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 }));
      routes.forEach((route, index) => {
        expect(route.points.slice(1).every((point, segment) => point.x === route.points[segment].x || point.y === route.points[segment].y)).toBe(true);
        for (const other of routes.slice(index + 1)) expect(sharedEdgeLength(route.points, other.points)).toBeLessThanOrEqual(12);
        for (const [id, node] of bounds) if (id !== edges[index].from && id !== edges[index].to) expect(crosses(route.points, node)).toBe(false);
        for (const [other, label] of labels.entries()) if (other !== index) expect(crosses(route.points, label)).toBe(false);
        expect(route.points.slice(1).some((end, segment) => {
          const start = route.points[segment];
          return route.label.x >= Math.min(start.x, end.x) && route.label.x <= Math.max(start.x, end.x) &&
            route.label.y >= Math.min(start.y, end.y) && route.label.y <= Math.max(start.y, end.y);
        })).toBe(true);
      });
    }
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

  it.each([2, 3])("separates paths and labels of %s calls with identical ports", count => {
    const routes = [...layoutEdges(Array.from({ length: count }, (_, index) => ({ ...bypass, id: String(index) })), nodes).values()];
    const labels = routes.map(route => ({ x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 }));
    expect(overlaps(labels[0], labels[1])).toBe(false);
    for (const route of routes) expect(crosses(route.points, nodes.get("middle")!)).toBe(false);
    expect(crosses(routes[1].points, labels[0])).toBe(false);
    routes.forEach((route, index) => {
      for (const other of routes.slice(index + 1)) expect(sharedEdgeLength(route.points, other.points)).toBeLessThanOrEqual(12);
      for (const [other, label] of labels.entries()) if (other !== index) expect(crosses(route.points, label)).toBe(false);
    });
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

describe("diagram fitting bounds", () => {
  it("includes a connection label below the measured Person and service rectangles", () => {
    expect(diagramBounds([
      { x: 0, y: 100, width: 192, height: 186 },
      { x: 780, y: 100, width: 192, height: 180 },
      { x: 404, y: 292, width: 163, height: 72 },
    ])).toEqual({ x: 0, y: 100, width: 972, height: 264 });
  });

  it("keeps negative and fractional origins without rounding off content", () => {
    expect(diagramBounds([
      { x: -25.5, y: -40.25, width: 100, height: 80 },
      { x: 120, y: 60, width: 50.5, height: 20.75 },
    ])).toEqual({ x: -25.5, y: -40.25, width: 196, height: 121 });
    expect(diagramBounds([])).toBeNull();
  });

  it("reports the routed path and full label rectangle for viewport fitting", () => {
    const route = layoutEdges([bypass], nodes).get("bypass")!;
    const label = { x: route.label.x - 50, y: route.label.y - 15, width: 100, height: 30 };
    const fit = route.bounds;
    expect(fit).toBeDefined();
    for (const point of [...route.points, { x: label.x, y: label.y }, { x: label.x + label.width, y: label.y + label.height }]) {
      expect(point.x).toBeGreaterThanOrEqual(fit.x);
      expect(point.x).toBeLessThanOrEqual(fit.x + fit.width);
      expect(point.y).toBeGreaterThanOrEqual(fit.y);
      expect(point.y).toBeLessThanOrEqual(fit.y + fit.height);
    }
  });
});


describe("manual edge geometry", () => {
  it("passes through model-space anchors, keeps exact ports and labels the longest segment", () => {
    const anchors = [{ x: 220, y: -400 }, { x: 1200, y: -400 }];
    const route = layoutEdges([{ ...bypass, points: anchors }], nodes).get(bypass.id)!;
    expect(route.points[0]).toEqual({ x: bypass.sourceX, y: bypass.sourceY });
    expect(route.points.at(-1)).toEqual({ x: bypass.targetX, y: bypass.targetY });
    for (const anchor of anchors) expect(route.points).toContainEqual(anchor);
    expect(route.points.slice(1).every((point, index) => point.x === route.points[index].x || point.y === route.points[index].y)).toBe(true);
    expect(route.label).toEqual({ x: 710, y: -400 });
    expect(route.bounds.x + route.bounds.width).toBeGreaterThanOrEqual(1200);
    expect(route.bounds.y).toBeLessThanOrEqual(-400);
    const moved = layoutEdges([{ ...bypass, sourceX: 100, sourceY: 220, points: anchors }], nodes).get(bypass.id)!;
    for (const anchor of anchors) expect(moved.points).toContainEqual(anchor);
  });

  it("does not avoid nodes for a manual path", () => {
    const route = layoutEdges([{ ...bypass, points: [{ x: 400, y: 140 }] }], nodes).get(bypass.id)!;
    expect(crosses(route.points, nodes.get("middle")!)).toBe(true);
  });

  it("routes automatic paths around manual labels even when the manual edge comes last", () => {
    const manual = { ...bypass, id: "manual", points: [{ x: 220, y: 140 }, { x: 640, y: 140 }] };
    const routes = layoutEdges([bypass, manual], new Map());
    const label = routes.get(manual.id)!.label;
    expect(label).toEqual({ x: 430, y: 140 });
    const rect = { x: label.x - 50, y: label.y - 15, width: 100, height: 30 };
    expect(crosses(routes.get(bypass.id)!.points, rect)).toBe(false);
    const autoLabel = routes.get(bypass.id)!.label;
    expect(overlaps(rect, { x: autoLabel.x - 50, y: autoLabel.y - 15, width: 100, height: 30 })).toBe(false);
  });
});
