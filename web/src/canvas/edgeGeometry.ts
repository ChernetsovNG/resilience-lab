import type { Rect, XYPosition } from "@xyflow/react";

export interface EdgeMeasurement {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  width: number;
  height: number;
}

export interface EdgeLayoutInput extends EdgeMeasurement {
  id: string;
  from: string;
  to: string;
}

export interface EdgeGeometry {
  path: string;
  points: XYPosition[];
  label: XYPosition;
}

const gap = 12;
const pathGap = 8;
// Fractional node positions and clearances can round the same boundary differently.
const epsilon = 1e-7;
const expand = (rect: Rect, amount: number): Rect => ({ x: rect.x - amount, y: rect.y - amount,
  width: rect.width + amount * 2, height: rect.height + amount * 2 });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width - epsilon && a.x + a.width > b.x + epsilon &&
  a.y < b.y + b.height - epsilon && a.y + a.height > b.y + epsilon;
const distance = (a: XYPosition, b: XYPosition) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const labelRect = (point: XYPosition, size: EdgeMeasurement): Rect => ({
  x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height,
});

function blocked(a: XYPosition, b: XYPosition, obstacles: Rect[]) {
  return obstacles.some(rect => a.y === b.y
    ? a.y > rect.y + epsilon && a.y < rect.y + rect.height - epsilon && Math.max(a.x, b.x) > rect.x + epsilon && Math.min(a.x, b.x) < rect.x + rect.width - epsilon
    : a.x > rect.x + epsilon && a.x < rect.x + rect.width - epsilon && Math.max(a.y, b.y) > rect.y + epsilon && Math.min(a.y, b.y) < rect.y + rect.height - epsilon);
}

function simplify(points: XYPosition[]): XYPosition[] {
  return points.filter((point, index) => {
    const before = points[index - 1];
    const after = points[index + 1];
    return before === undefined || after === undefined ||
      !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y)) ||
      distance(before, point) + distance(point, after) > distance(before, after) + epsilon;
  });
}

/** A* on obstacle boundaries; only horizontal/vertical segments in free space are connected. */
function corridor(start: XYPosition, end: XYPosition, obstacles: Rect[]): XYPosition[] {
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(rect => [rect.x, rect.x + rect.width])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(rect => [rect.y, rect.y + rect.height])])].sort((a, b) => a - b);
  const point = (index: number) => ({ x: xs[index % xs.length], y: ys[Math.floor(index / xs.length)] });
  const first = ys.indexOf(start.y) * xs.length + xs.indexOf(start.x);
  const last = ys.indexOf(end.y) * xs.length + xs.indexOf(end.x);
  const costs = new Map([[first, 0]]);
  const previous = new Map<number, number>();
  const visited = new Set<number>();
  const open = [first];
  while (open.length > 0) {
    // ponytail: sorted frontier is sufficient for canvas-sized graphs; use a heap if profiling warrants it.
    open.sort((a, b) => costs.get(a)! + distance(point(a), end) - costs.get(b)! - distance(point(b), end) || costs.get(b)! - costs.get(a)!);
    const current = open.shift()!;
    if (visited.has(current)) continue;
    if (current === last) {
      const path = [end];
      for (let index = last; index !== first;) {
        index = previous.get(index)!;
        path.push(point(index));
      }
      return simplify(path.reverse());
    }
    visited.add(current);
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    const neighbors = [x + 1 < xs.length ? current + 1 : -1, y > 0 ? current - xs.length : -1,
      y + 1 < ys.length ? current + xs.length : -1, x > 0 ? current - 1 : -1];
    for (const next of neighbors) {
      if (next < 0 || visited.has(next) || blocked(point(current), point(next), obstacles)) continue;
      const cost = costs.get(current)! + distance(point(current), point(next));
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost);
      previous.set(next, current);
      open.push(next);
    }
  }
  // Overlapping node footprints can enclose a port. Keep the edge selectable while the user moves them apart.
  return [start, end];
}

function pathBounds(points: XYPosition[]): Rect[] {
  return points.slice(1).map((end, index) => ({ x: Math.min(points[index].x, end.x) - 1,
    y: Math.min(points[index].y, end.y) - 1, width: Math.abs(points[index].x - end.x) + 2,
    height: Math.abs(points[index].y - end.y) + 2 }));
}

function placeLabel(points: XYPosition[], size: EdgeMeasurement, obstacles: Rect[]): XYPosition | undefined {
  const total = points.slice(1).reduce((sum, end, index) => sum + distance(points[index], end), 0);
  const candidates: { point: XYPosition; cost: number }[] = [];
  let travelled = 0;
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const horizontal = start.y === end.y;
    const axis = horizontal ? "x" : "y";
    const length = distance(start, end);
    const minimum = Math.min(start[axis], end[axis]);
    const maximum = Math.max(start[axis], end[axis]);
    const half = (horizontal ? size.width : size.height) / 2;
    const coordinates = [(start[axis] + end[axis]) / 2,
      start[axis] + Math.sign(end[axis] - start[axis]) * Math.max(0, Math.min(length, total / 2 - travelled)),
      ...obstacles.flatMap(rect => [rect[axis] - half, rect[axis] + (horizontal ? rect.width : rect.height) + half])];
    for (const coordinate of coordinates) {
      if (coordinate < minimum || coordinate > maximum) continue;
      const point = { ...start, [axis]: coordinate };
      if (!obstacles.some(rect => overlaps(labelRect(point, size), rect))) {
        candidates.push({ point, cost: Math.abs(travelled + distance(start, point) - total / 2) });
      }
    }
    travelled += length;
  }
  return candidates.sort((a, b) => a.cost - b.cost)[0]?.point;
}

/** Routes in document order so labels never depend on React render or observer delivery order. */
export function layoutEdges(edges: EdgeLayoutInput[], nodes: ReadonlyMap<string, Rect>): Map<string, EdgeGeometry> {
  const geometries = new Map<string, EdgeGeometry>();
  const labels: Rect[] = [];
  const previousPaths: Rect[] = [];
  const entries = [...nodes].filter(([, rect]) => rect.width > 0 && rect.height > 0);
  const bounds = entries.map(([, rect]) => rect);
  let diagramClearance = pathGap;
  bounds.forEach((a, index) => bounds.slice(index + 1).forEach(b => {
    const dx = Math.max(a.x - b.x - b.width, b.x - a.x - a.width);
    const dy = Math.max(a.y - b.y - b.height, b.y - a.y - a.height);
    const separation = Math.max(dx, dy);
    if (separation > 0) diagramClearance = Math.min(diagramClearance, separation / 3);
  }));
  for (const edge of edges) {
    const source = { x: edge.sourceX, y: edge.sourceY };
    const target = { x: edge.targetX, y: edge.targetY };
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const sourcePort = { x: Math.max(source.x, from === undefined ? source.x : from.x + from.width), y: source.y };
    const targetPort = { x: Math.min(target.x, to?.x ?? target.x), y: target.y };
    const separation = (point: XYPosition, rect: Rect) => Math.max(0, rect.x - point.x, point.x - rect.x - rect.width,
      rect.y - point.y, point.y - rect.y - rect.height);
    let clearance = diagramClearance;
    for (const [id, rect] of entries) {
      if (id !== edge.from) clearance = Math.min(clearance, separation(sourcePort, rect) / 3);
      if (id !== edge.to) clearance = Math.min(clearance, separation(targetPort, rect) / 3);
    }
    const start = { x: sourcePort.x + clearance, y: source.y };
    const end = { x: targetPort.x - clearance, y: target.y };
    // Leave the port corridor free: labels keep a larger node clearance than either routing margin.
    const obstacles = [...bounds.map(rect => expand(rect, clearance)), ...labels.map(rect => expand(rect, 4))];
    const labelObstacles = [...bounds, ...labels, ...previousPaths].map(rect => expand(rect, gap));
    let points = [source, ...corridor(start, end, obstacles), target];
    let label = placeLabel(points, edge, labelObstacles);
    if (edge.width > 0 && edge.height > 0 && label === undefined) {
      // A wide label gets its own horizontal segment in the nearest free lane above or below obstacles.
      const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      label = [center.y, ...labelObstacles.flatMap(rect => [rect.y - edge.height / 2, rect.y + rect.height + edge.height / 2])]
        .map(y => ({ x: center.x, y })).filter(point => !labelObstacles.some(rect => overlaps(labelRect(point, edge), rect)))
        .sort((a, b) => Math.abs(a.y - center.y) - Math.abs(b.y - center.y))[0];
      const left = { x: label.x - edge.width / 2 - (gap - pathGap), y: label.y };
      const right = { x: label.x + edge.width / 2 + (gap - pathGap), y: label.y };
      const [entry, exit] = start.x <= end.x ? [left, right] : [right, left];
      points = [source, ...corridor(start, entry, obstacles), ...corridor(exit, end, obstacles), target];
    }
    points = simplify(points);
    geometries.set(edge.id, { points, label: label ?? source,
      path: points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ") });
    if (edge.width > 0 && edge.height > 0) labels.push(labelRect(label!, edge));
    previousPaths.push(...pathBounds(points));
  }
  return geometries;
}
