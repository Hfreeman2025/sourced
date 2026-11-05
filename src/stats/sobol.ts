import { stream } from './random';

/** Variance-based sensitivity indices from the Saltelli sampling design.
 *
 * Inputs: model outputs f(A), f(B) for two independent sample matrices, and
 * f(A_B⁽ⁱ⁾) where column i of A is replaced by column i of B. Estimators:
 *
 *   first order  Sᵢ  = mean( f(B) · (f(A_B⁽ⁱ⁾) − f(A)) ) / V      Saltelli et al. 2010
 *   total        Sₜᵢ = mean( (f(A) − f(A_B⁽ⁱ⁾))² ) / (2V)        Jansen 1999
 *
 * V is the variance of f(A) ∪ f(B). Outputs are centred on their sample mean
 * first, as Sobol' (2001) recommends, which removes most of the estimator's
 * noise when the mean is large relative to the spread. Intervals are 95%
 * percentile bootstraps over rows. */
export interface SobolIndex {
  first: number;
  total: number;
  firstLow: number;
  firstHigh: number;
  totalLow: number;
  totalHigh: number;
}

export interface SobolEstimate {
  indices: SobolIndex[];
  /** Output variance relative to the largest |output|²; 0 when it does not vary. */
  variance: number;
  rows: number;
  dropped: number;
  resamples: number;
}

/** Per-row terms, flattened: [a + b, a² + b², first₀…firstₖ₋₁, total₀…totalₖ₋₁].
 * Each bootstrap resample is then a run of additions over contiguous memory. */
function rowTerms(rows: number[], fA: Float64Array, fB: Float64Array, fAB: Float64Array[]) {
  const k = fAB.length,
    width = 2 * k + 2,
    terms = new Float64Array(rows.length * width);
  rows.forEach((j, r) => {
    const a = fA[j] ?? 0,
      b = fB[j] ?? 0,
      base = r * width;
    terms[base] = a + b;
    terms[base + 1] = a * a + b * b;
    for (let i = 0; i < k; i++) {
      const ab = fAB[i]?.[j] ?? 0;
      terms[base + 2 + i] = b * (ab - a);
      terms[base + 2 + k + i] = (a - ab) * (a - ab);
    }
  });
  return { terms, width, k };
}

function indices(sums: Float64Array, n: number, k: number) {
  const mean = (sums[0] ?? 0) / (2 * n);
  const variance = (sums[1] ?? 0) / (2 * n) - mean * mean;
  const first: number[] = [],
    total: number[] = [];
  for (let i = 0; i < k; i++) {
    first.push((sums[2 + i] ?? 0) / n / variance);
    total.push((sums[2 + k + i] ?? 0) / (2 * n) / variance);
  }
  return { variance, first, total };
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  const h = (sorted.length - 1) * p,
    lower = Math.floor(h);
  const a = sorted[lower] ?? Number.NaN,
    b = sorted[Math.min(sorted.length - 1, lower + 1)] ?? a;
  return a + (h - lower) * (b - a);
};

export function sobolIndices(
  fA: Float64Array,
  fB: Float64Array,
  fAB: Float64Array[],
  { resamples = 100, seed = 1 }: { resamples?: number; seed?: number } = {},
): SobolEstimate {
  const n = fA.length;
  const valid: number[] = [];
  let centre = 0,
    largest = 0;
  for (let j = 0; j < n; j++) {
    const a = fA[j] ?? Number.NaN,
      b = fB[j] ?? Number.NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (!fAB.every((column) => Number.isFinite(column[j] ?? Number.NaN))) continue;
    valid.push(j);
    centre += a + b;
    largest = Math.max(largest, Math.abs(a), Math.abs(b));
  }
  centre /= 2 * Math.max(1, valid.length);
  // Indices are ratios of variances, so they are unchanged by centring and
  // scaling; scaling by the largest output keeps squares finite at any size.
  const scale = largest || 1;
  const shift = (column: Float64Array) => column.map((value) => (value - centre) / scale);
  const a = shift(fA),
    b = shift(fB),
    ab = fAB.map(shift);
  const empty = (variance: number): SobolEstimate => ({
    indices: fAB.map(() => ({
      first: Number.NaN,
      total: Number.NaN,
      firstLow: Number.NaN,
      firstHigh: Number.NaN,
      totalLow: Number.NaN,
      totalHigh: Number.NaN,
    })),
    variance,
    rows: valid.length,
    dropped: n - valid.length,
    resamples: 0,
  });
  if (valid.length < 2) return empty(0);
  const { terms, width, k } = rowTerms(valid, a, b, ab);
  const rows = valid.length,
    sums = new Float64Array(width);
  for (let r = 0; r < rows; r++)
    for (let m = 0; m < width; m++) sums[m] = (sums[m] ?? 0) + (terms[r * width + m] ?? 0);
  const point = indices(sums, rows, k);
  // Relative to the output's own magnitude (now 1), a variance this small is
  // floating-point noise (for example, every run rounded to one value).
  if (!(point.variance > 1e-24)) return empty(0);
  const next = stream(seed, 'sobol-bootstrap');
  const firsts: number[][] = fAB.map(() => []),
    totals: number[][] = fAB.map(() => []);
  for (let r = 0; r < resamples; r++) {
    sums.fill(0);
    for (let d = 0; d < rows; d++) {
      const base = Math.floor(((next() + 0.5) / 4294967296) * rows) * width;
      // Indices are in range by construction; skip the undefined checks in this hot loop.
      for (let m = 0; m < width; m++) sums[m] = (sums[m] as number) + (terms[base + m] as number);
    }
    const sample = indices(sums, rows, k);
    sample.first.forEach((value, i) => {
      firsts[i]?.push(value);
    });
    sample.total.forEach((value, i) => {
      totals[i]?.push(value);
    });
  }
  return {
    indices: fAB.map((_, i) => ({
      first: point.first[i] ?? Number.NaN,
      total: point.total[i] ?? Number.NaN,
      firstLow: percentile(firsts[i] ?? [], 0.025),
      firstHigh: percentile(firsts[i] ?? [], 0.975),
      totalLow: percentile(totals[i] ?? [], 0.025),
      totalHigh: percentile(totals[i] ?? [], 0.975),
    })),
    variance: point.variance,
    rows: valid.length,
    dropped: n - valid.length,
    resamples,
  };
}
