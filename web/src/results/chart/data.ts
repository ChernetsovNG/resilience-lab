import type { ChartYScale } from "./types";

export function linearScale(domain: readonly [number, number], range: readonly [number, number]) {
  return (value: number) => domain[0] === domain[1] ? (range[0] + range[1]) / 2
    : range[0] + (value - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0]);
}

function tickStep(span: number, count: number) {
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
}

/** Numeric ticks omit a domain endpoint when its neighbor is at most half a step away. */
export function axisTicks([min, max]: readonly [number, number], count = 6): number[] {
  if (min === max) return [min];
  const step = tickStep(max - min, count - 1);
  const first = Math.ceil(min / step);
  const ticks = [min];
  for (let i = 0; i < count * 2; i++) {
    const value = Number(((first + i) * step).toPrecision(12));
    if (value >= max - step * 1e-9) break;
    if (value > min + step * 1e-9) ticks.push(value);
  }
  ticks.push(max);
  return ticks.length <= 2 ? ticks : ticks.filter((value, index) => index === 0 ? ticks[1] - value > step * (0.5 + 1e-9)
    : index === ticks.length - 1 ? value - ticks[index - 1] > step * (0.5 + 1e-9) : true);
}

export function yDomain(values: Iterable<number | null>, scale: ChartYScale = { scale: "zero" }): [number, number] {
  if (scale.scale === "manual") return [scale.min, scale.max];
  let min = Infinity, max = -Infinity;
  for (const value of values) if (value !== null && Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  if (min === Infinity) return [0, 1];
  if (scale.scale === "zero") { min = Math.min(0, min); max = Math.max(0, max); }
  if (scale.scale === "zero" && min === 0 && max === 0) return [0, 1];
  if (min === max) { const padding = Math.max(1, Math.abs(min) * 0.1); min -= padding; max += padding; }
  const step = tickStep(max - min, 6);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

/** First, last, min and max per screen pixel, plus both edges of every missing-value gap. */
export function samplePoints<T extends { value: number | null }>(points: readonly T[], pixels: number, x: (point: T) => number): T[] {
  if (points.length <= Math.max(1, pixels)) return [...points];
  const count = Math.max(1, Math.floor(pixels));
  const start = x(points[0]);
  const span = x(points.at(-1)!) - start || 1;
  const keep = new Set<number>([0, points.length - 1]);
  let bucket = -1;
  let first = 0, last = 0, min = 0, max = 0;
  const flush = () => { if (bucket >= 0) for (const index of [first, last, min, max]) keep.add(index); };
  for (let index = 0; index < points.length; index++) {
    const value = points[index].value;
    if (index > 0 && (value === null) !== (points[index - 1].value === null)) {
      keep.add(index - 1);
      keep.add(index);
    }
    if (value === null) continue;
    const next = Math.min(count - 1, Math.floor((x(points[index]) - start) / span * count));
    if (next !== bucket) { flush(); bucket = next; first = min = max = index; }
    last = index;
    if (value < points[min].value!) min = index;
    if (value > points[max].value!) max = index;
  }
  flush();
  return [...keep].sort((a, b) => a - b).map(index => points[index]);
}

/** Both recorded boundaries contribute extrema and gap edges to the shared sample. */
export function sampleBand<T extends { range: readonly [number, number] | null }>(points: readonly T[], pixels: number, x: (point: T) => number): T[] {
  const keep = new Set([0, 1].flatMap(bound => samplePoints(points.map(point => ({ point, value: point.range?.[bound] ?? null })),
    pixels, item => x(item.point)).map(item => item.point)));
  return points.filter(point => keep.has(point));
}

/** Step-after segments close at recorded window ends; null values always break the path. */
export function stepPath(points: readonly { x: number; endX?: number; value: number | null }[], x: (value: number) => number, y: (value: number) => number): string {
  let path = "", connected = false;
  for (const [index, point] of points.entries()) {
    if (point.value === null) { connected = false; continue; }
    path += connected ? `H${x(point.x)}V${y(point.value)}` : `M${x(point.x)},${y(point.value)}`;
    if ((points[index + 1]?.value ?? null) === null && point.endX !== undefined) path += `H${x(point.endX)}`;
    connected = true;
  }
  return path;
}

export function bandPath(points: readonly { x: number; endX?: number; range: readonly [number, number] | null }[], x: (value: number) => number, y: (value: number) => number): string {
  let path = "";
  let segment: { x: number; endX?: number; range: readonly [number, number] }[] = [];
  const close = () => {
    if (segment.length === 0) return;
    const last = segment.at(-1)!;
    path += stepPath(segment.map(point => ({ ...point, value: point.range[1] })), x, y);
    path += `L${x(last.endX ?? last.x)},${y(last.range[0])}`;
    for (let i = segment.length - 1; i > 0; i--) path += `H${x(segment[i].x)}V${y(segment[i - 1].range[0])}`;
    path += `H${x(segment[0].x)}Z`;
    segment = [];
  };
  for (const point of points) { if (point.range === null) close(); else segment.push({ ...point, range: point.range }); }
  close();
  return path;
}

export function windowAt(timeMs: number, windowMs: number, endMs: number): number {
  return Math.max(0, Math.min(Math.ceil(endMs / windowMs) - 1, Math.floor(timeMs / windowMs)));
}
