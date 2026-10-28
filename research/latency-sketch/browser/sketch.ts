export const PROFILE = 'ddsketch-bitwise6-rational-v1';
export const MAX_COUNT = 9_007_199_254_740_990;
const MAX_SPAN = 2048;
const MIN_INDEX = -65344;
const MAX_INDEX = 65471;
const view = new DataView(new ArrayBuffer(8));

export function requireProfile(profile: unknown): void {
  if (profile !== PROFILE) throw new Error(`Unsupported sketch profile: ${String(profile)}`);
}

function count(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_COUNT) {
    throw new Error('Invalid sketch count');
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

export function bits(value: number | null): string | null {
  if (value === null) return null;
  view.setFloat64(0, value);
  return view.getUint32(0).toString(16).padStart(8, '0') + view.getUint32(4).toString(16).padStart(8, '0');
}

/** Integer-only state; errors leave the receiver unchanged. */
export class Sketch {
  private readonly bins = new Map<number, number>();
  private zeroCount = 0;
  private total = 0;
  private low = Infinity;
  private high = -Infinity;

  static decode(profile: unknown, data: unknown): Sketch {
    requireProfile(profile);
    if (!Array.isArray(data) || data.length % 2 !== 1 || data.length > 1 + 2 * MAX_SPAN) {
      throw new Error('Expected canonical [zeroCount,index,count,...]');
    }
    const result = new Sketch();
    result.zeroCount = count(data[0], 0);
    result.total = result.zeroCount;
    for (let offset = 1; offset < data.length; offset += 2) {
      const index: unknown = data[offset];
      if (typeof index !== 'number' || !Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX || index <= result.high) {
        throw new Error('Invalid or unsorted sketch index');
      }
      const n = count(data[offset + 1], 1);
      result.preflight(n, index, index);
      result.bins.set(index, n);
      result.total += n;
      result.low = Math.min(result.low, index);
      result.high = index;
    }
    return result;
  }

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0 || (value !== 0 && (value < 2 ** -1021 || value >= 2 ** 1023))) {
      throw new Error('Sample outside supported nonnegative binary64 range');
    }
    if (value === 0) {
      this.preflight(1, Infinity, -Infinity);
      this.zeroCount += 1;
    } else {
      view.setFloat64(0, value);
      const highBits = view.getUint32(0);
      const index = ((highBits >>> 20) - 1023) * 64 + ((highBits & 0xfffff) >>> 14);
      this.preflight(1, index, index);
      this.bins.set(index, (this.bins.get(index) ?? 0) + 1);
      this.low = Math.min(this.low, index);
      this.high = Math.max(this.high, index);
    }
    this.total += 1;
  }

  merge(other: Sketch): void {
    this.preflight(other.total, other.low, other.high);
    const incomingTotal = other.total;
    this.zeroCount += other.zeroCount;
    for (const [index, n] of other.bins) this.bins.set(index, (this.bins.get(index) ?? 0) + n);
    this.total += incomingTotal;
    this.low = Math.min(this.low, other.low);
    this.high = Math.max(this.high, other.high);
  }

  encode(): number[] {
    const result = [this.zeroCount];
    for (const [index, n] of this.orderedBins()) result.push(index, n);
    return result;
  }

  /** KSL position p*(n+1), interpolated between approximate order statistics. */
  quantile(p: number): number | null {
    if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new Error('Probability must be finite and in (0,1)');
    if (this.total === 0) return null;
    const bins = this.orderedBins();
    const rank = (position: number): number => {
      if (position < this.zeroCount) return 0;
      let cumulative = this.zeroCount;
      for (const [index, n] of bins) {
        cumulative += n;
        if (position < cumulative) return representative(index);
      }
      throw new Error('Rank outside sketch');
    };
    if (this.total === 1) return rank(0);
    const position = p * (this.total + 1);
    if (position < 1) return rank(0);
    if (position >= this.total) return rank(this.total - 1);
    const floor = Math.floor(position);
    const a = rank(floor - 1);
    const b = rank(floor);
    return a + (position - floor) * (b - a);
  }

  private orderedBins(): [number, number][] {
    return [...this.bins].sort((a, b) => a[0] - b[0]);
  }

  private preflight(n: number, low: number, high: number): void {
    if (n > MAX_COUNT - this.total) throw new Error('Sketch count limit exceeded');
    if (Math.max(this.high, high) - Math.min(this.low, low) + 1 > MAX_SPAN) {
      throw new Error('Sketch index span limit exceeded');
    }
  }
}
