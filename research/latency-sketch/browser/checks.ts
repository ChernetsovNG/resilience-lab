import { bits, MAX_COUNT, PROFILE, Sketch } from './sketch.js';

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function same(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: ${a?.slice(0, 300)} != ${b?.slice(0, 300)}`);
}

export function selfCheck(): void {
  const sketch = new Sketch();
  for (const value of [0, 1, 2]) sketch.add(value);
  same(sketch.encode(), [1, 0, 1, 64, 1], 'Zero and power-of-two bins');
  same([0.125, 0.25, 0.5, 0.625, 0.75].map(p => sketch.quantile(p)),
    [0, 0, 1.0078125, 1.51171875, 2.015625], 'KSL interpolation and endpoint clamping');
  same(bits(sketch.quantile(0.5)), '3ff0200000000000', 'Big-endian quantile bits');
  same(new Sketch().quantile(0.5), null, 'Empty sketch');
  const singleton = new Sketch();
  singleton.add(0.5);
  same(singleton.encode(), [0, -64, 1], 'Negative exponent');
  same(singleton.quantile(0.99), 0.50390625, 'Singleton representative');
  const boundary = new Sketch();
  for (const value of [1.9999999999999998, 2, 2.03125]) boundary.add(value);
  same(boundary.encode(), [0, 63, 1, 64, 1, 65, 1], 'Mantissa and exponent boundaries');

  const before = sketch.encode();
  for (const value of [-1, NaN, Infinity, -Infinity, Number.MIN_VALUE, 2 ** -1022, 2 ** 1023]) {
    rejects(() => sketch.add(value), 'Invalid sample');
    same(sketch.encode(), before, 'Failed ingest is atomic');
  }
  for (const p of [-1, 0, 1, 2, NaN, Infinity]) rejects(() => new Sketch().quantile(p), 'Invalid probability');
  for (const value of [2 ** -1021, 2 ** 1023 - 2 ** 970]) {
    const extreme = new Sketch();
    extreme.add(value);
    const estimate = extreme.quantile(0.5);
    assert(estimate !== null && Math.abs(estimate / value - 1) <= 1 / 128, 'Supported extreme representative');
  }
  for (const input of [null, [], [0, 1], [-1], [1.5], [MAX_COUNT + 1], [0, 0, 0],
    [0, 0, -1], [0, 0, 1.5], [0, 1, 1, 0, 1], [0, 0, 1, 0, 1],
    [0, -65345, 1], [0, 65472, 1], [0, 0.5, 1], [MAX_COUNT, 0, 1], [0, 0, 1, 2048, 1]]) {
    rejects(() => Sketch.decode(PROFILE, input), 'Malformed sketch');
  }
  rejects(() => Sketch.decode('incompatible-profile', [0]), 'Profile mismatch');
  const wide = Sketch.decode(PROFILE, [0, 0, 1, 2047, 1]);
  const wideBefore = wide.encode();
  rejects(() => wide.add(2 ** 32), 'Ingest span cap');
  rejects(() => wide.merge(Sketch.decode(PROFILE, [0, 2048, 1])), 'Merge span cap');
  same(wide.encode(), wideBefore, 'Span errors leave the receiver unchanged');
  const full = Sketch.decode(PROFILE, [MAX_COUNT - 1]);
  full.merge(Sketch.decode(PROFILE, [1]));
  same(full.encode(), [MAX_COUNT], 'Maximum exact count');
  rejects(() => full.add(0), 'Ingest count cap');
  rejects(() => full.merge(Sketch.decode(PROFILE, [1])), 'Merge count cap');
  same(full.encode(), [MAX_COUNT], 'Count errors leave the receiver unchanged');
  boundary.merge(boundary);
  same(boundary.encode(), [0, 63, 2, 64, 2, 65, 2], 'Self merge');
}

function rejects(action: () => unknown, message: string): void {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  assert(rejected, message);
}

export const ORDERS = ['forward', 'reverse', 'random', 'balanced'] as const;
export type MergeOrder = typeof ORDERS[number];

export function mergeWindows(windows: Sketch[], order: MergeOrder): Sketch {
  if (order === 'balanced') {
    let level = windows;
    while (level.length > 1) {
      const next: Sketch[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const merged = new Sketch();
        merged.merge(level[i]!);
        if (i + 1 < level.length) merged.merge(level[i + 1]!);
        next.push(merged);
      }
      level = next;
    }
    return level[0] ?? new Sketch();
  }
  const ordered = [...windows];
  if (order === 'reverse') ordered.reverse();
  if (order === 'random') {
    let state = 67;
    for (let i = ordered.length - 1; i > 0; i--) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const j = state % (i + 1);
      [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
    }
  }
  const result = new Sketch();
  for (const window of ordered) result.merge(window);
  return result;
}
