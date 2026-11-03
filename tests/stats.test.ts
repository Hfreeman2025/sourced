import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillUniform, stream, xoshiro128ss } from '../src/stats/random';
import { inverseNormal } from '../src/stats/normal';
import { fillSamples, inverseCdf, moments, type Distribution } from '../src/stats/distributions';
import { histogram, quantileSorted, summarise } from '../src/stats/summary';
import { sobolIndices } from '../src/stats/sobol';

test('xoshiro128** reproduces the reference sequence for state 1, 2, 3, 4', () => {
  // The first four outputs were derived by hand from the published algorithm.
  const next = xoshiro128ss(1, 2, 3, 4);
  assert.deepEqual([next(), next(), next(), next()], [11520, 0, 5927040, 70819200]);
});

test('named streams are deterministic, distinct and uniform inside (0, 1)', () => {
  const first = fillUniform(new Float64Array(50_000), 7, 'usage');
  const again = fillUniform(new Float64Array(50_000), 7, 'usage');
  const other = fillUniform(new Float64Array(50_000), 7, 'rate');
  const reseeded = fillUniform(new Float64Array(50_000), 8, 'usage');
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.notDeepEqual(first, reseeded);
  let sum = 0;
  for (const u of first) {
    assert.ok(u > 0 && u < 1);
    sum += u;
  }
  // Mean of 50,000 uniforms: standard error 0.0013; allow four of them.
  assert.ok(Math.abs(sum / first.length - 0.5) < 0.0052);
  assert.notEqual(stream(1, 'a')(), stream(1, 'b')());
});

test('inverse normal matches published quantiles to 1e-8', () => {
  for (const [p, z] of [
    [0.5, 0],
    [0.975, 1.959963984540054],
    [0.95, 1.6448536269514722],
    [0.8413447460685429, 1],
    [0.001, -3.090232306167813],
    [1e-10, -6.361340902404056],
  ] as const)
    assert.ok(Math.abs(inverseNormal(p) - z) < 1e-8 * Math.max(1, Math.abs(z)), `p=${p}`);
  assert.ok(Number.isNaN(inverseNormal(0)) && Number.isNaN(inverseNormal(1)));
  // Symmetry across the central/tail joins.
  for (const p of [0.01, 0.02425, 0.1, 0.3])
    assert.ok(Math.abs(inverseNormal(p) + inverseNormal(1 - p)) < 1e-9);
});

test('every distribution reproduces its exact mean and variance from 200,000 draws', () => {
  const uniforms = fillUniform(new Float64Array(200_000), 2026, 'moments');
  const cases: Distribution[] = [
    { kind: 'uniform', low: 0.72, high: 0.775 },
    { kind: 'normal', mean: 0.065, sd: 0.0078 },
    { kind: 'split-normal', mode: 69_300, left: 918.4, right: 1887.8, coverage: 0.95 },
    { kind: 'lognormal', median: 950, sigma: Math.log(1.2) },
    { kind: 'triangular', low: 60, mode: 70, high: 100 },
  ];
  for (const dist of cases) {
    const { summary } = summarise(fillSamples(dist, uniforms));
    const exact = moments(dist),
      sd = Math.sqrt(exact.variance);
    // Standard error of the mean is sd/√n ≈ 0.0022 sd; allow five of them.
    assert.ok(Math.abs(summary.mean - exact.mean) < 0.011 * sd, `${dist.kind} mean`);
    assert.ok(Math.abs(summary.sd / sd - 1) < 0.01, `${dist.kind} sd`);
  }
});

test('a two-piece normal keeps the stated value as its mode and 95% between the limits', () => {
  const dist: Distribution = {
    kind: 'split-normal',
    mode: 69_300,
    left: 1800 / 1.959963984540054,
    right: 3700 / 1.959963984540054,
    coverage: 0.95,
  };
  // The CDF at the limits is exact by construction.
  const below = 2 * (dist.left / (dist.left + dist.right)) * 0.025;
  const above = 2 * (dist.right / (dist.left + dist.right)) * 0.025;
  assert.ok(Math.abs(inverseCdf(dist, below) - 67_500) < 1e-4);
  assert.ok(Math.abs(inverseCdf(dist, 1 - above) - 73_000) < 1e-4);
  assert.ok(Math.abs(inverseCdf(dist, dist.left / (dist.left + dist.right)) - 69_300) < 1e-9);
  const draws = fillSamples(dist, fillUniform(new Float64Array(200_000), 3, 'split'));
  let inside = 0;
  for (const x of draws) if (x >= 67_500 && x <= 73_000) inside++;
  // Binomial standard error at p = 0.95, n = 200,000 is 0.00049.
  assert.ok(Math.abs(inside / draws.length - 0.95) < 0.0025);
});

test('triangular and lognormal quantiles have exact closed forms', () => {
  const tri: Distribution = { kind: 'triangular', low: 0, mode: 1, high: 4 };
  assert.equal(inverseCdf(tri, 0.25), 1);
  assert.ok(Math.abs(inverseCdf(tri, 0.75) - (4 - Math.sqrt(0.25 * 4 * 3))) < 1e-12);
  const log: Distribution = { kind: 'lognormal', median: 10, sigma: Math.log(2) };
  assert.equal(inverseCdf(log, 0.5), 10);
  assert.ok(Math.abs(inverseCdf(log, 0.975) - 10 * 2 ** 1.959963984540054) < 1e-6);
});

test('type 7 quantiles, summaries and histograms are exact on small samples', () => {
  const sorted = Float64Array.from([1, 2, 3, 4, 5]);
  assert.equal(quantileSorted(sorted, 0), 1);
  assert.equal(quantileSorted(sorted, 0.5), 3);
  assert.equal(quantileSorted(sorted, 0.05), 1.2);
  assert.equal(quantileSorted(sorted, 0.95), 4.8);
  const { summary } = summarise(Float64Array.from([5, 1, 4, 2, 3]));
  assert.deepEqual(
    [summary.mean, summary.min, summary.max, summary.p50, summary.sd],
    [3, 1, 5, 3, Math.sqrt(2.5)],
  );
  const bins = histogram(Float64Array.from([0, 0.5, 1, 1.5, 2, 9]), 2, 0, 2);
  assert.deepEqual([bins.counts, bins.below, bins.above], [[2, 3], 0, 1]);
});

test('Sobol indices recover an additive model exactly in expectation', () => {
  // Y = X1 + 2·X2 + 0·X3 with independent unit normals: S = T = (1/5, 4/5, 0).
  const n = 20_000;
  const column = (name: string) =>
    fillSamples({ kind: 'normal', mean: 0, sd: 1 }, fillUniform(new Float64Array(n), 11, name));
  const A = [column('A1'), column('A2'), column('A3')];
  const B = [column('B1'), column('B2'), column('B3')];
  const model = (x: Float64Array[]) =>
    Float64Array.from({ length: n }, (_, j) => (x[0]?.[j] ?? 0) + 2 * (x[1]?.[j] ?? 0));
  const fAB = [0, 1, 2].map((i) => model(A.map((col, c) => (c === i ? (B[c] ?? col) : col))));
  const result = sobolIndices(model(A), model(B), fAB, { resamples: 100, seed: 5 });
  const expected = [0.2, 0.8, 0];
  result.indices.forEach((index, i) => {
    assert.ok(Math.abs(index.first - (expected[i] ?? 0)) < 0.03, `S${i + 1} ${index.first}`);
    assert.ok(Math.abs(index.total - (expected[i] ?? 0)) < 0.03, `T${i + 1} ${index.total}`);
    assert.ok(index.firstLow <= index.first && index.first <= index.firstHigh);
  });
  assert.equal(result.indices[2]?.total, 0);
  assert.equal(result.dropped, 0);
});

test('Sobol total indices expose the interaction in a product of normals', () => {
  // Y = X1·X2, X1 ~ N(1, 1), X2 ~ N(2, 0.5). V = μ2²σ1² + μ1²σ2² + σ1²σ2² = 4.5.
  // S1 = 4/4.5, S2 = 0.25/4.5, interaction 0.25/4.5, so T1 = 4.25/4.5, T2 = 0.5/4.5.
  const n = 40_000;
  const draw = (name: string, mean: number, sd: number) =>
    fillSamples({ kind: 'normal', mean, sd }, fillUniform(new Float64Array(n), 3, name));
  const A = [draw('A1', 1, 1), draw('A2', 2, 0.5)];
  const B = [draw('B1', 1, 1), draw('B2', 2, 0.5)];
  const model = (x: Float64Array[]) =>
    Float64Array.from({ length: n }, (_, j) => (x[0]?.[j] ?? 0) * (x[1]?.[j] ?? 0));
  const fAB = [0, 1].map((i) => model(A.map((col, c) => (c === i ? (B[c] ?? col) : col))));
  const [x1, x2] = sobolIndices(model(A), model(B), fAB, { resamples: 100 }).indices;
  assert.ok(x1 && x2);
  assert.ok(Math.abs(x1.first - 4 / 4.5) < 0.03, `S1 ${x1.first}`);
  assert.ok(Math.abs(x2.first - 0.25 / 4.5) < 0.03, `S2 ${x2.first}`);
  assert.ok(Math.abs(x1.total - 4.25 / 4.5) < 0.03, `T1 ${x1.total}`);
  assert.ok(Math.abs(x2.total - 0.5 / 4.5) < 0.03, `T2 ${x2.total}`);
  // The interaction is visible as T − S on both inputs.
  assert.ok(x2.total - x2.first > 0.03);
});

test('Sobol estimation drops undefined rows and reports a constant output as no variance', () => {
  const ones = new Float64Array(10).fill(1);
  const constant = sobolIndices(ones, ones, [ones]);
  assert.equal(constant.variance, 0);
  assert.ok(Number.isNaN(constant.indices[0]?.first));
  const holes = Float64Array.from({ length: 10 }, (_, i) => (i === 3 ? Number.NaN : i));
  const estimate = sobolIndices(holes, Float64Array.from({ length: 10 }, (_, i) => 9 - i), [holes]);
  assert.equal(estimate.dropped, 1);
  assert.equal(estimate.rows, 9);
});
