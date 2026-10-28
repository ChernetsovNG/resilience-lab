import { assert, mergeWindows, ORDERS, same, selfCheck } from './checks.js';
import { bits, PROFILE, requireProfile, Sketch } from './sketch.js';

type WindowSet = {
  windows: Sketch[];
  merged: number[];
  probabilities: number[];
  mergedQuantileBits: (string | null)[];
};
type Timing = {
  parseMs: number;
  validateDecodeMs: number;
  mergeMs: number;
  quantilesMs: number;
  mergeAndQuantilesMs: number;
};

function object(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected JSON object');
  return value as Record<string, unknown>;
}

function probabilities(value: unknown): number[] {
  assert(Array.isArray(value) && value.length > 0 && value.every(p => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1),
    'Expected finite probabilities in (0,1)');
  return value as number[];
}

function quantileBits(value: unknown): (string | null)[] {
  assert(Array.isArray(value) && value.every(v => v === null || (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v))),
    'Expected binary64 hex strings or null');
  return value as (string | null)[];
}

function readWindows(value: unknown): WindowSet {
  const data = object(value);
  requireProfile(data.profile);
  assert(Array.isArray(data.windows) && data.windows.length === 600, 'Expected 600 window sketches');
  const p = probabilities(data.probabilities);
  const expectedBits = quantileBits(data.mergedQuantileBits);
  assert(expectedBits.length === p.length, 'Quantile/probability count mismatch');
  return {
    windows: data.windows.map(window => Sketch.decode(data.profile, window)),
    merged: Sketch.decode(data.profile, data.merged).encode(),
    probabilities: p,
    mergedQuantileBits: expectedBits,
  };
}

function verifyMerged(sketch: Sketch, input: WindowSet, context: string): void {
  same(sketch.encode(), input.merged, `${context} canonical bins`);
  same(input.probabilities.map(p => bits(sketch.quantile(p))), input.mergedQuantileBits, `${context} quantile bits`);
}

function verifyFixtures(text: string): number {
  const data = object(JSON.parse(text));
  requireProfile(data.profile);
  assert(Array.isArray(data.cases) && data.cases.length > 0, 'Missing JVM cases');
  for (const item of data.cases) {
    const c = object(item);
    assert(typeof c.name === 'string' && Array.isArray(c.values), 'Invalid case');
    const sketch = new Sketch();
    for (const value of c.values) {
      assert(typeof value === 'number', `${c.name}: expected numeric sample`);
      sketch.add(value);
    }
    same(sketch.encode(), Sketch.decode(data.profile, c.sketch).encode(), `${c.name} canonical bins`);
    same(probabilities(c.probabilities).map(p => bits(sketch.quantile(p))), quantileBits(c.quantileBits), `${c.name} quantile bits`);
  }
  const windows = readWindows(data);
  for (const order of ORDERS) verifyMerged(mergeWindows(windows.windows, order), windows, `Fixture ${order}`);
  return data.cases.length;
}

function measure(text: string): Timing {
  const startParse = performance.now();
  const value: unknown = JSON.parse(text);
  const endParse = performance.now();
  const input = readWindows(value);
  const endDecode = performance.now();
  const merged = mergeWindows(input.windows, 'forward');
  const endMerge = performance.now();
  const results = input.probabilities.map(p => merged.quantile(p));
  const endQuantiles = performance.now();

  // Correctness checks, encoding and comparison are outside the reported timers.
  same(merged.encode(), input.merged, 'Forward canonical bins');
  same(results.map(bits), input.mergedQuantileBits, 'Forward quantile bits');
  for (const order of ORDERS.slice(1)) verifyMerged(mergeWindows(input.windows, order), input, order);
  return {
    parseMs: endParse - startParse,
    validateDecodeMs: endDecode - endParse,
    mergeMs: endMerge - endDecode,
    quantilesMs: endQuantiles - endMerge,
    mergeAndQuantilesMs: endQuantiles - endDecode,
  };
}

function summary(trials: (Timing & { decompressUtf8Ms?: number })[]): Record<string, { median: number; min: number; max: number }> {
  const result: Record<string, { median: number; min: number; max: number }> = {};
  for (const key of Object.keys(trials[0]!) as (keyof (Timing & { decompressUtf8Ms?: number }))[]) {
    const values = trials.map(trial => trial[key]!).sort((a, b) => a - b);
    result[key] = { median: values[Math.floor(values.length / 2)]!, min: values[0]!, max: values.at(-1)! };
  }
  return result;
}

async function load(path: string): Promise<Response> {
  const response = await fetch(path);
  assert(response.ok, `Cannot read ${path}: ${response.status}`);
  return response;
}

export async function run() {
  selfCheck();
  const [fixtures, selected, compressed] = await Promise.all([
    load('/fixtures.json').then(r => r.text()),
    load('/selected-ui.json').then(r => r.text()),
    load('/selected-ui.json.gz').then(r => r.arrayBuffer()),
  ]);
  let fixtureCases = 0;
  const trials: Timing[] = [];
  const gzipTrials: (Timing & { decompressUtf8Ms: number })[] = [];
  for (let trial = 0; trial < 9; trial++) {
    fixtureCases = verifyFixtures(fixtures);
    const plain = measure(selected);
    const start = performance.now();
    const text = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const decompressUtf8Ms = performance.now() - start;
    same(text, selected, 'Gzip preserves exact JSON text');
    const gzip = { ...measure(text), decompressUtf8Ms };
    if (trial >= 2) {
      trials.push(plain);
      gzipTrials.push(gzip);
    }
  }
  return {
    profile: PROFILE,
    warmups: 2,
    measurements: 7,
    windows: 600,
    fixtureCases,
    mergeOrders: ORDERS,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    validation: 'canonical-arrays-and-binary64-quantiles-every-trial',
    timingScope: 'Input fetched before timing; gzip includes UTF-8 decoding; validation/decoding separate; merge and quantiles exclude comparison and encoding.',
    json: { trials, summaryMs: summary(trials) },
    gzip: { trials: gzipTrials, summaryMs: summary(gzipTrials) },
  };
}
