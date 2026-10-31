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
  bounds: Rect;
}

/** Full model-space extent of measured nodes, routed lines and connection labels. */
export function diagramBounds(rectangles: Iterable<Rect>): Rect | null {
  const entries = [...rectangles];
  if (entries.length === 0) return null;
  const x = Math.min(...entries.map(rect => rect.x));
  const y = Math.min(...entries.map(rect => rect.y));
  return { x, y, width: Math.max(...entries.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...entries.map(rect => rect.y + rect.height)) - y };
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

interface FrontierEntry { index: number; cost: number; estimate: number }
// Lowest f first, then highest g, then lowest grid-cell index: identical inputs choose the same path.
const compareEntries = (a: FrontierEntry, b: FrontierEntry) =>
  a.estimate - b.estimate || b.cost - a.cost || a.index - b.index;

class Frontier {
  private entries: FrontierEntry[] = [];
  private positions = new Map<number, number>();

  get size() { return this.entries.length; }

  push(index: number, cost: number, heuristic: number) {
    const existing = this.positions.get(index);
    const entry = { index, cost, estimate: cost + heuristic };
    let position = existing ?? this.entries.length;
    if (existing === undefined) this.entries.push(entry);
    while (position > 0) {
      const parent = (position - 1) >>> 1;
      if (compareEntries(this.entries[parent], entry) <= 0) break;
      this.entries[position] = this.entries[parent];
      this.positions.set(this.entries[position].index, position);
      position = parent;
    }
    this.entries[position] = entry;
    this.positions.set(index, position);
  }

  pop(): FrontierEntry {
    const first = this.entries[0];
    const last = this.entries.pop()!;
    this.positions.delete(first.index);
    if (this.entries.length > 0) {
      let position = 0;
      while (position * 2 + 1 < this.entries.length) {
        let child = position * 2 + 1;
        if (child + 1 < this.entries.length && compareEntries(this.entries[child + 1], this.entries[child]) < 0) child++;
        if (compareEntries(last, this.entries[child]) <= 0) break;
        this.entries[position] = this.entries[child];
        this.positions.set(this.entries[position].index, position);
        position = child;
      }
      this.entries[position] = last;
      this.positions.set(last.index, position);
    }
    return first;
  }
}

/** A* on obstacle boundaries; only horizontal/vertical segments in free space are connected.
 * Occupied lines prohibit collinear reuse but allow perpendicular crossings. */
export function corridor(start: XYPosition, end: XYPosition, obstacles: Rect[], occupied: Rect[] = []): XYPosition[] {
  const free = (a: XYPosition, b: XYPosition) => !blocked(a, b, obstacles) && !occupied.some(rect => a.y === b.y
      ? rect.height === 0 && Math.abs(a.y - rect.y) < epsilon && Math.min(Math.max(a.x, b.x), rect.x + rect.width) > Math.max(Math.min(a.x, b.x), rect.x) + epsilon
      : rect.width === 0 && Math.abs(a.x - rect.x) < epsilon && Math.min(Math.max(a.y, b.y), rect.y + rect.height) > Math.max(Math.min(a.y, b.y), rect.y) + epsilon);
  for (const corner of [{ x: end.x, y: start.y }, { x: start.x, y: end.y }]) {
    if (free(start, corner) && free(corner, end)) return simplify([start, corner, end]);
  }
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(rect => [rect.x, rect.x + rect.width]),
    ...occupied.flatMap(rect => rect.width === 0 ? [rect.x - pathGap, rect.x, rect.x + pathGap] : [rect.x, rect.x + rect.width])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(rect => [rect.y, rect.y + rect.height]),
    ...occupied.flatMap(rect => rect.height === 0 ? [rect.y - pathGap, rect.y, rect.y + pathGap] : [rect.y, rect.y + rect.height])])].sort((a, b) => a - b);
  const point = (index: number) => ({ x: xs[index % xs.length], y: ys[Math.floor(index / xs.length)] });
  const first = ys.indexOf(start.y) * xs.length + xs.indexOf(start.x);
  const last = ys.indexOf(end.y) * xs.length + xs.indexOf(end.x);
  const costs = new Map([[first, 0]]);
  const previous = new Map<number, number>();
  const visited = new Set<number>();
  const open = new Frontier();
  open.push(first, 0, distance(start, end));
  while (open.size > 0) {
    const current = open.pop().index;
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
    const currentPoint = point(current);
    for (const next of neighbors) {
      if (next < 0 || visited.has(next)) continue;
      const nextPoint = point(next);
      if (!free(currentPoint, nextPoint)) continue;
      const cost = costs.get(current)! + distance(currentPoint, nextPoint);
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost);
      previous.set(next, current);
      open.push(next, cost, distance(nextPoint, end));
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

function occupiedPath(points: XYPosition[]): Rect[] {
  const total = points.slice(1).reduce((sum, end, index) => sum + distance(points[index], end), 0);
  if (total <= gap) return [];
  const portGap = Math.min(gap, total / 3);
  let travelled = 0;
  return points.slice(1).flatMap((end, index) => {
    const start = points[index];
    const length = distance(start, end);
    const from = Math.max(0, portGap - travelled);
    const to = Math.min(length, total - portGap - travelled);
    travelled += length;
    if (to <= from + epsilon) return [];
    const axis = start.y === end.y ? "x" : "y";
    const sign = Math.sign(end[axis] - start[axis]);
    const a = { ...start, [axis]: start[axis] + sign * from };
    const b = { ...start, [axis]: start[axis] + sign * to };
    return [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }];
  });
}

function placeLabel(points: XYPosition[], size: EdgeMeasurement, obstacles: Rect[]): XYPosition | undefined {
  const total = points.slice(1).reduce((sum, end, index) => sum + distance(points[index], end), 0);
  let best: { point: XYPosition; cost: number } | undefined;
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
    for (const coordinate of new Set(coordinates)) {
      if (coordinate < minimum || coordinate > maximum) continue;
      const point = { ...start, [axis]: coordinate };
      const cost = Math.abs(travelled + distance(start, point) - total / 2);
      if (best !== undefined && cost >= best.cost) continue;
      const candidate = labelRect(point, size);
      if (!obstacles.some(rect => overlaps(candidate, rect))) {
        best = { point, cost };
      }
    }
    travelled += length;
  }
  return best?.point;
}

/** Routes in document order so labels never depend on React render or observer delivery order. */
export function layoutEdges(edges: EdgeLayoutInput[], nodes: ReadonlyMap<string, Rect>): Map<string, EdgeGeometry> {
  const geometries = new Map<string, EdgeGeometry>();
  const labels: Rect[] = [];
  const previousPaths: Rect[] = [];
  const outgoing = new Map<string, Rect[][]>();
  const incoming = new Map<string, Rect[][]>();
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
    clearance = Math.min(clearance, Math.max(0, gap - (sourcePort.x - source.x)), Math.max(0, gap - (target.x - targetPort.x)));
    const sourceRoutes = outgoing.get(edge.from) ?? [];
    const targetRoutes = incoming.get(edge.to) ?? [];
    const sourceClearance = clearance / (sourceRoutes.length + 1);
    const targetClearance = clearance / (targetRoutes.length + 1);
    const nodeClearance = Math.min(sourceClearance, targetClearance);
    const start = { x: sourcePort.x + sourceClearance, y: source.y };
    const end = { x: targetPort.x - targetClearance, y: target.y };
    // Leave the port corridor free: labels keep a larger node clearance than either routing margin.
    const obstacles = [...bounds.map(rect => expand(rect, nodeClearance)), ...labels.map(rect => expand(rect, 4))];
    const labelObstacles = [...bounds, ...labels, ...previousPaths].map(rect => expand(rect, gap));
    // Reserve only sibling routes; up to 12 px at either end remain available for the common port.
    const occupied = [...sourceRoutes.flat(), ...targetRoutes.flat()];
    let points = [source, ...corridor(start, end, obstacles, occupied), target];
    let label = placeLabel(points, edge, labelObstacles);
    if (edge.width > 0 && edge.height > 0 && label === undefined) {
      // A wide label gets its own horizontal segment in the nearest free lane above or below obstacles.
      const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      label = [...new Set([center.y, ...labelObstacles.flatMap(rect => [rect.y - edge.height / 2, rect.y + rect.height + edge.height / 2])])]
        .map(y => ({ x: center.x, y })).sort((a, b) => Math.abs(a.y - center.y) - Math.abs(b.y - center.y)).find(point => {
          const candidate = labelRect(point, edge);
          return !labelObstacles.some(rect => overlaps(candidate, rect));
        })!;
      const left = { x: label.x - edge.width / 2 - (gap - pathGap), y: label.y };
      const right = { x: label.x + edge.width / 2 + (gap - pathGap), y: label.y };
      const [entry, exit] = start.x <= end.x ? [left, right] : [right, left];
      points = [source, ...corridor(start, entry, obstacles, occupied), ...corridor(exit, end, obstacles, occupied), target];
    }
    points = simplify(points);
    geometries.set(edge.id, { points, label: label ?? source,
      bounds: diagramBounds([...points.map(point => ({ ...point, width: 0, height: 0 })), labelRect(label ?? source, edge)])!,
      path: points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ") });
    if (edge.width > 0 && edge.height > 0) labels.push(labelRect(label!, edge));
    previousPaths.push(...pathBounds(points));
    const reserved = occupiedPath(points);
    outgoing.set(edge.from, [...sourceRoutes, reserved]);
    incoming.set(edge.to, [...targetRoutes, reserved]);
  }
  return geometries;
}
