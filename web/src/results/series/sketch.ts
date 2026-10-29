import { MessageError } from "../../i18n/MessageError";

export const LATENCY_PROFILE = "ddsketch-bitwise6-rational-v1";

const MAX_COUNT = 9_007_199_254_740_990;
const MAX_SPAN = 2048;
const MIN_INDEX = -65344;
const MAX_INDEX = 65471;
const view = new DataView(new ArrayBuffer(8));

function count(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > MAX_COUNT) {
    throw new MessageError("results.series.sketch.invalidCount");
  }
  return value;
}

function representative(index: number): number {
  const exponent = Math.floor(index / 64);
  const mantissa = index - exponent * 64;
  view.setUint32(0, (exponent + 1023) * 0x100000 + mantissa * 0x4000);
  view.setUint32(4, 0);
  return view.getFloat64(0) * (129 / 128);
}

/** Decoded `ddsketch-bitwise6-rational-v1` bins with KSL quantile interpolation. */
export class LatencySketch {
  private constructor(
    private readonly zeroCount: number,
    private readonly bins: ReadonlyArray<readonly [number, number]>,
    private readonly total: number,
  ) {}

  static decode(profile: unknown, data: unknown): LatencySketch {
    if (profile !== LATENCY_PROFILE) throw new MessageError("results.series.sketch.unsupportedProfile", { profile: String(profile) });
    if (!Array.isArray(data) || data.length % 2 !== 1 || data.length > 1 + 2 * MAX_SPAN) {
      throw new MessageError("results.series.sketch.canonical");
    }
    const zeroCount = count(data[0], 0);
    let total = zeroCount;
    let low = Infinity;
    let high = -Infinity;
    const bins: [number, number][] = [];
    for (let offset = 1; offset < data.length; offset += 2) {
      const index: unknown = data[offset];
      if (typeof index !== "number" || !Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX || index <= high) {
        throw new MessageError("results.series.sketch.invalidIndex");
      }
      const n = count(data[offset + 1], 1);
      if (n > MAX_COUNT - total) throw new MessageError("results.series.sketch.countLimit");
      if (Math.max(high, index) - Math.min(low, index) + 1 > MAX_SPAN) {
        throw new MessageError("results.series.sketch.indexSpanLimit");
      }
      bins.push([index, n]);
      total += n;
      low = Math.min(low, index);
      high = index;
    }
    return new LatencySketch(zeroCount, bins, total);
  }

  quantile(probability: number): number | null {
    if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
      throw new MessageError("results.series.sketch.probability");
    }
    if (this.total === 0) return null;
    const rank = (position: number): number => {
      if (position < this.zeroCount) return 0;
      let cumulative = this.zeroCount;
      for (const [index, n] of this.bins) {
        cumulative += n;
        if (position < cumulative) return representative(index);
      }
      throw new MessageError("results.series.sketch.rank");
    };
    if (this.total === 1) return rank(0);
    const position = probability * (this.total + 1);
    if (position < 1) return rank(0);
    if (position >= this.total) return rank(this.total - 1);
    const floor = Math.floor(position);
    const a = rank(floor - 1);
    const b = rank(floor);
    return a + (position - floor) * (b - a);
  }
}
