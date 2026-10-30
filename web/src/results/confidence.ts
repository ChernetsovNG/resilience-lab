export const CONFIDENCE_LEVELS = [80, 90, 95, 99] as const;
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number];
export type ConfidenceInterval = readonly [number, number];

const lanczos = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
  12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];

/** Lanczos log Γ for the positive arguments (at least 1/2) used by Student's distribution. */
function logGamma(value: number): number {
  const z = value - 1;
  const sum = lanczos.reduce((sum, coefficient, index) => sum + coefficient / (z + index + 1), 0.9999999999998099);
  const shifted = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(shifted) - shifted + Math.log(sum);
}

/** Incomplete beta continued fraction, evaluated by modified Lentz iteration (DLMF §8.17(v)). */
function betaFraction(a: number, b: number, x: number): number {
  const nonzero = (value: number) => Math.abs(value) < 1e-300 ? 1e-300 : value;
  let c = 1, d = 1 / nonzero(1 - (a + b) * x / (a + 1)), result = d;
  for (let m = 1; m <= 200; m += 1) {
    const even = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / nonzero(1 + even * d);
    c = nonzero(1 + even / c);
    result *= d * c;
    const odd = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / nonzero(1 + odd * d);
    c = nonzero(1 + odd / c);
    const change = d * c;
    result *= change;
    if (Math.abs(change - 1) < 1e-14) return result;
  }
  return NaN;
}

function regularizedBeta(x: number, a: number, b: number, logBeta: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - regularizedBeta(1 - x, b, a, logBeta);
  return Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBeta) * betaFraction(a, b, x) / a;
}

/** Invert the Student CDF by bisection; its positive tail is I(ν/(ν+t²); ν/2, 1/2)/2. */
export function studentTQuantile(probability: number, degreesOfFreedom: number): number {
  if (!(probability > 0 && probability < 1) || !Number.isFinite(degreesOfFreedom) || degreesOfFreedom < 1) return NaN;
  if (probability === 0.5) return 0;
  if (probability < 0.5) return -studentTQuantile(1 - probability, degreesOfFreedom);
  if (degreesOfFreedom === 1) return Math.tan(Math.PI * (probability - 0.5));
  if (degreesOfFreedom === 2) return (2 * probability - 1) / Math.sqrt(2 * probability * (1 - probability));
  const a = degreesOfFreedom / 2;
  const logBeta = logGamma(a) + logGamma(0.5) - logGamma(a + 0.5);
  const tail = (t: number) => regularizedBeta(degreesOfFreedom / (degreesOfFreedom + t * t), a, 0.5, logBeta) / 2;
  const target = 1 - probability;
  let low = 0, high = 1;
  while (tail(high) > target) high *= 2;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    const remaining = tail(middle);
    if (!Number.isFinite(remaining)) return NaN;
    if (remaining > target) low = middle;
    else high = middle;
    if (high - low < 1e-12 * Math.max(1, middle)) break;
  }
  return (low + high) / 2;
}

/** Replication uncertainty only: absent spread or fewer than two observations means no interval. Bounds stay unclipped. */
export function confidenceInterval(metric: { mean: number | null; stdDev?: number | null } | null | undefined,
  replications: number, level: ConfidenceLevel): ConfidenceInterval | null {
  if (metric?.mean == null || !Number.isFinite(metric.mean) || metric.stdDev == null
    || !Number.isFinite(metric.stdDev) || metric.stdDev < 0 || !Number.isInteger(replications) || replications < 2) return null;
  const radius = studentTQuantile((1 + level / 100) / 2, replications - 1) * metric.stdDev / Math.sqrt(replications);
  return Number.isFinite(radius) ? [metric.mean - radius, metric.mean + radius] : null;
}
