/** Sample statistics for a Monte Carlo result. */
export interface Summary {
  count: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  p5: number;
  p50: number;
  p95: number;
}

export interface Histogram {
  low: number;
  high: number;
  counts: number[];
  /** Samples outside the drawn range, so long tails are reported, not hidden. */
  below: number;
  above: number;
}

/** Hyndman & Fan type 7 (the default in R and NumPy): linear interpolation
 * between order statistics at h = (n − 1)p. `sorted` must be ascending. */
export function quantileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (!n) return Number.NaN;
  const h = (n - 1) * Math.min(1, Math.max(0, p)),
    lower = Math.floor(h);
  const a = sorted[lower] ?? Number.NaN,
    b = sorted[Math.min(n - 1, lower + 1)] ?? a;
  return a + (h - lower) * (b - a);
}

/** Sorts a copy and summarises it. Two-pass variance avoids cancellation,
 * and sums run on values scaled by the largest magnitude, so quantities near
 * the floating-point limit never overflow the mean. */
export function summarise(values: Float64Array): { summary: Summary; sorted: Float64Array } {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const scale = Math.max(Math.abs(sorted[0] ?? 0), Math.abs(sorted[n - 1] ?? 0)) || 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (sorted[i] ?? 0) / scale;
  const centre = n ? sum / n : Number.NaN;
  let squares = 0;
  for (let i = 0; i < n; i++) squares += ((sorted[i] ?? 0) / scale - centre) ** 2;
  return {
    sorted,
    summary: {
      count: n,
      mean: centre * scale,
      sd: n > 1 ? Math.sqrt(squares / (n - 1)) * scale : 0,
      min: sorted[0] ?? Number.NaN,
      max: sorted[n - 1] ?? Number.NaN,
      p5: quantileSorted(sorted, 0.05),
      p50: quantileSorted(sorted, 0.5),
      p95: quantileSorted(sorted, 0.95),
    },
  };
}

/** Equal-width bins over [low, high]. Values on the upper edge fall in the last bin. */
export function histogram(sorted: Float64Array, bins: number, low: number, high: number): Histogram {
  const counts = new Array<number>(bins).fill(0);
  let below = 0,
    above = 0;
  const width = (high - low) / bins;
  for (let i = 0; i < sorted.length; i++) {
    const x = sorted[i] ?? 0;
    if (x < low) below++;
    else if (x > high) above++;
    else {
      const bin = width > 0 ? Math.min(bins - 1, Math.floor((x - low) / width)) : 0;
      counts[bin] = (counts[bin] ?? 0) + 1;
    }
  }
  return { low, high, counts, below, above };
}
