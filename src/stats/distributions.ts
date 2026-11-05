import { inverseNormal } from './normal';

/** A resolved input distribution, in the literal's own unit. */
export type Distribution =
  | { kind: 'uniform'; low: number; high: number }
  | { kind: 'normal'; mean: number; sd: number }
  /** Two half-normals joined at the mode. With left = (mode − low) / z and
   * right = (high − mode) / z, exactly `coverage` of the probability lies
   * between low and high while the mode stays at the stated value. */
  | { kind: 'split-normal'; mode: number; left: number; right: number; coverage: number }
  | { kind: 'lognormal'; median: number; sigma: number }
  | { kind: 'triangular'; low: number; mode: number; high: number };

export function inverseCdf(dist: Distribution, u: number): number {
  switch (dist.kind) {
    case 'uniform':
      return dist.low + u * (dist.high - dist.low);
    case 'normal':
      return dist.mean + dist.sd * inverseNormal(u);
    case 'lognormal':
      return dist.median * Math.exp(dist.sigma * inverseNormal(u));
    case 'triangular': {
      const width = dist.high - dist.low,
        split = (dist.mode - dist.low) / width;
      return u < split
        ? dist.low + Math.sqrt(u * width * (dist.mode - dist.low))
        : dist.high - Math.sqrt((1 - u) * width * (dist.high - dist.mode));
    }
    case 'split-normal': {
      const total = dist.left + dist.right;
      if (total === 0) return dist.mode;
      const w = dist.left / total;
      return u < w
        ? dist.mode + dist.left * inverseNormal(u / (2 * w))
        : dist.mode + dist.right * inverseNormal(0.5 + (u - w) / (2 * (1 - w)));
    }
  }
}

/** Maps uniforms through the inverse CDF. One uniform per sample keeps every
 * draw reproducible and lets a scrubbed value reuse the same random numbers. */
export function fillSamples(
  dist: Distribution,
  uniforms: Float64Array,
  out: Float64Array = new Float64Array(uniforms.length),
): Float64Array {
  for (let i = 0; i < uniforms.length; i++) out[i] = inverseCdf(dist, uniforms[i] ?? 0.5);
  return out;
}

/** Exact mean and variance, used by tests and by the reference text. */
export function moments(dist: Distribution): { mean: number; variance: number } {
  switch (dist.kind) {
    case 'uniform':
      return { mean: (dist.low + dist.high) / 2, variance: (dist.high - dist.low) ** 2 / 12 };
    case 'normal':
      return { mean: dist.mean, variance: dist.sd ** 2 };
    case 'lognormal': {
      const s2 = dist.sigma ** 2;
      return {
        mean: dist.median * Math.exp(s2 / 2),
        variance: (Math.exp(s2) - 1) * dist.median ** 2 * Math.exp(s2),
      };
    }
    case 'triangular': {
      const { low: a, mode: c, high: b } = dist;
      return {
        mean: (a + b + c) / 3,
        variance: (a * a + b * b + c * c - a * b - a * c - b * c) / 18,
      };
    }
    case 'split-normal': {
      const gap = dist.right - dist.left;
      return {
        mean: dist.mode + Math.sqrt(2 / Math.PI) * gap,
        variance: (1 - 2 / Math.PI) * gap * gap + dist.left * dist.right,
      };
    }
  }
}

/** Plain-language name, used beside each uncertain input. */
export function shapeName(dist: Distribution): string {
  return {
    uniform: 'uniform',
    normal: 'normal',
    'split-normal': 'two-piece normal',
    lognormal: 'lognormal',
    triangular: 'triangular',
  }[dist.kind];
}

/** Unnormalised density, for drawing an input's shape. */
export function density(dist: Distribution, x: number): number {
  switch (dist.kind) {
    case 'uniform':
      return x >= dist.low && x <= dist.high ? 1 : 0;
    case 'normal':
      return Math.exp(-(((x - dist.mean) / dist.sd) ** 2) / 2);
    case 'split-normal': {
      const sd = x < dist.mode ? dist.left : dist.right;
      return sd > 0 ? Math.exp(-(((x - dist.mode) / sd) ** 2) / 2) : x === dist.mode ? 1 : 0;
    }
    case 'lognormal':
      return x > 0 ? Math.exp(-((Math.log(x / dist.median) / dist.sigma) ** 2) / 2) / x : 0;
    case 'triangular':
      if (x < dist.low || x > dist.high) return 0;
      return x <= dist.mode
        ? dist.mode === dist.low
          ? 1
          : (x - dist.low) / (dist.mode - dist.low)
        : dist.high === dist.mode
          ? 1
          : (dist.high - x) / (dist.high - dist.mode);
  }
}

/** A small outline of the shape: `points` heights in [0, 1] over a range that
 * shows the edges of bounded shapes and the bulk of unbounded ones. */
export function silhouette(dist: Distribution, points = 24): number[] {
  const low = inverseCdf(dist, 0.001),
    high = inverseCdf(dist, 0.999);
  const pad = (high - low) * 0.14 || 1;
  const values = Array.from({ length: points }, (_, i) =>
    density(dist, low - pad + ((high - low + 2 * pad) * i) / (points - 1)),
  );
  const peak = Math.max(...values) || 1;
  return values.map((value) => value / peak);
}
