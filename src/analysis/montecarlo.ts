import type { RunResult } from '../lang';
import { parse } from '../lang/parser';
import type { Program } from '../lang/types';
import { fillSamples } from '../stats/distributions';
import { fillUniform } from '../stats/random';
import { sobolIndices } from '../stats/sobol';
import { histogram, quantileSorted, summarise, type Histogram, type Summary } from '../stats/summary';
import { evaluateColumns, expand, type ColumnEvaluation } from './columns';
import type { InputLiteral } from './inputs';
import { contributingInputs } from './sensitivity';

export const PREVIEW_RUNS = 4_096;
export const MONTE_CARLO_RUNS = 100_000;
/** Base rows for Sobol estimation; the design costs base × (k + 2) runs. */
export const SOBOL_BASE = 16_384;
export const SOBOL_RESAMPLES = 100;
export const DEFAULT_SEED = 1;

export interface OutputDistribution {
  /** No uncertain input reaches this output: every run gives `central`. */
  exact: boolean;
  central: number;
  unit: string;
  summary?: Summary;
  histogram?: Histogram;
  undefinedRuns: number;
}

export interface Propagation {
  outputs: (OutputDistribution | null)[];
  runs: number;
  seed: number;
  uncertain: number;
}

export interface SobolRow {
  inputId: string;
  first: number;
  total: number;
  firstLow: number;
  firstHigh: number;
  totalLow: number;
  totalHigh: number;
}

export interface VarianceShares {
  rows: SobolRow[];
  base: number;
  evaluations: number;
  dropped: number;
  resamples: number;
  /** False when the output does not vary at all (for example, after rounding). */
  varies: boolean;
}

const uncertain = (inputs: InputLiteral[]) =>
  inputs.filter((input) => input.role === 'value' && input.uncertainty);

/** Recently drawn columns. Draws are a pure function of (seed, stream, runs,
 * distribution), and nothing writes to a sampled column, so a drag that moves
 * one quantity reuses every other quantity's draws instead of reallocating. */
const drawn = new Map<string, Float64Array>();
const DRAWN_LIMIT = 48;
function draw(key: string, make: () => Float64Array): Float64Array {
  const hit = drawn.get(key);
  if (hit) {
    drawn.delete(key);
    drawn.set(key, hit);
    return hit;
  }
  const column = make();
  drawn.set(key, column);
  if (drawn.size > DRAWN_LIMIT) drawn.delete(drawn.keys().next().value ?? '');
  return column;
}

/** Draws `runs` samples for every uncertain literal. Each literal has its own
 * stream, named by its stable input id, so editing or dragging one quantity
 * leaves every other quantity's random numbers unchanged. */
export function sampleInputs(
  inputs: InputLiteral[],
  runs: number,
  seed: number,
  matrix = 'mc',
): Map<number, Float64Array> {
  const columns = new Map<number, Float64Array>();
  for (const input of uncertain(inputs)) {
    const distribution = input.uncertainty?.distribution;
    if (!distribution) continue;
    const name = `${matrix}:${input.id}`;
    const uniforms = draw(`${seed}|${name}|${runs}`, () =>
      fillUniform(new Float64Array(runs), seed, name),
    );
    columns.set(
      input.literal.start,
      draw(`${seed}|${name}|${runs}|${JSON.stringify(distribution)}`, () =>
        fillSamples(distribution, uniforms),
      ),
    );
  }
  return columns;
}

const describe = (
  evaluation: ColumnEvaluation,
  result: RunResult,
  index: number,
): OutputDistribution | null => {
  const column = evaluation.outputs[index],
    value = result.outputs[index]?.value;
  if (!column || !value) return null;
  const central = value.amount,
    unit = value.unit.symbol;
  if (typeof column.lane === 'number') return { exact: true, central, unit, undefinedRuns: 0 };
  const all = expand(column, evaluation);
  const valid = all.filter((x) => !Number.isNaN(x));
  if (!valid.length) return { exact: false, central, unit, undefinedRuns: evaluation.size };
  const { summary, sorted } = summarise(valid);
  // Draw the central 99%, extended to show the central-input answer. Runs
  // beyond the drawing are counted, and the figure states their share.
  const low = Math.min(quantileSorted(sorted, 0.005), central),
    high = Math.max(quantileSorted(sorted, 0.995), central);
  return {
    exact: false,
    central,
    unit,
    summary,
    // A 4,096-run preview gets coarser bins: its shape, not its sampling noise.
    histogram: histogram(sorted, evaluation.size >= 50_000 ? 60 : 36, low, high),
    undefinedRuns: evaluation.size - valid.length,
  };
};

export function propagate(
  source: string,
  result: RunResult,
  inputs: InputLiteral[],
  runs = MONTE_CARLO_RUNS,
  seed = DEFAULT_SEED,
  program: Program = parse(source),
): Propagation {
  const columns = sampleInputs(inputs, runs, seed);
  const evaluation = evaluateColumns(program, columns, runs);
  return {
    outputs: result.outputs.map((_, i) => describe(evaluation, result, i)),
    runs,
    seed,
    uncertain: columns.size,
  };
}

/** First-order and total Sobol indices for one output, over the uncertain
 * inputs that reach it. Fixed inputs have no variance to share. */
export function varianceShares(
  source: string,
  result: RunResult,
  inputs: InputLiteral[],
  outputIndex: number,
  base = SOBOL_BASE,
  seed = DEFAULT_SEED,
  program: Program = parse(source),
): VarianceShares {
  const reaching = contributingInputs(result, outputIndex, inputs).filter((input) => input.uncertainty);
  if (!reaching.length)
    return { rows: [], base, evaluations: 0, dropped: 0, resamples: 0, varies: false };
  const A = sampleInputs(reaching, base, seed, 'A'),
    B = sampleInputs(reaching, base, seed, 'B');
  const output = (columns: Map<number, Float64Array>) => {
    const evaluation = evaluateColumns(program, columns, base);
    return expand(evaluation.outputs[outputIndex], evaluation);
  };
  const fA = output(A),
    fB = output(B);
  const fAB = reaching.map((input) => {
    const mixed = new Map(A),
      key = input.literal.start;
    const replacement = B.get(key);
    if (replacement) mixed.set(key, replacement);
    return output(mixed);
  });
  const estimate = sobolIndices(fA, fB, fAB, { resamples: SOBOL_RESAMPLES, seed });
  return {
    rows: reaching.map((input, i) => {
      const index = estimate.indices[i];
      return {
        inputId: input.id,
        first: index?.first ?? Number.NaN,
        total: index?.total ?? Number.NaN,
        firstLow: index?.firstLow ?? Number.NaN,
        firstHigh: index?.firstHigh ?? Number.NaN,
        totalLow: index?.totalLow ?? Number.NaN,
        totalHigh: index?.totalHigh ?? Number.NaN,
      };
    }),
    base,
    evaluations: base * (reaching.length + 2),
    dropped: estimate.dropped,
    resamples: estimate.resamples,
    varies: estimate.variance > 0,
  };
}
