import type { Rect, XYPosition } from "@xyflow/react";

const epsilon = 1e-7;
const distance = (a: XYPosition, b: XYPosition) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

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

/** Frozen A* from 8c2d2c5; only tests use this sorted frontier as a path-length oracle. */
export function legacyCorridor(start: XYPosition, end: XYPosition, obstacles: Rect[]): XYPosition[] {
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
