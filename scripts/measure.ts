import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { examples } from '../src/examples';
import { run, parse, check, compile } from '../src/lang';
import { collectInputs } from '../src/analysis/inputs';
import {
  MONTE_CARLO_RUNS,
  PREVIEW_RUNS,
  propagate,
  varianceShares,
} from '../src/analysis/montecarlo';
import { loadavg } from 'node:os';
const runs = 200;
const timed = (repeat: number, work: () => void) => {
  const samples: number[] = [];
  for (let i = 0; i < repeat + 3; i++) {
    const start = performance.now();
    work();
    if (i >= 3) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return Number((samples[Math.floor(samples.length / 2)] ?? 0).toFixed(2));
};
const rows = examples.map((example) => {
  const samples: number[] = [];
  for (let i = 0; i < runs + 20; i++) {
    const start = performance.now();
    const result = run(example.code);
    if (result.diagnostics.length)
      throw new Error(`${example.id}: ${result.diagnostics[0]?.message}`);
    if (i >= 20) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const program = parse(example.code);
  const checked = check(program);
  if (checked.length) throw new Error('Example failed checking');
  return {
    example: example.id,
    sourceCharacters: example.code.length,
    checkingAndEvaluationMedianMs: Number((samples[Math.floor(runs / 2)] ?? 0).toFixed(3)),
    checkingAndEvaluationP95Ms: Number((samples[Math.floor(runs * 0.95)] ?? 0).toFixed(3)),
    generatedJavaScriptBytes: Buffer.byteLength(compile(program)),
    nodes: run(example.code).nodes.length,
    ...(() => {
      const result = run(example.code),
        inputs = collectInputs(example.code);
      const uncertain = inputs.filter((input) => input.uncertainty).length;
      if (!uncertain) return { uncertainInputs: 0 };
      return {
        uncertainInputs: uncertain,
        previewMedianMs: timed(30, () => propagate(example.code, result, inputs, PREVIEW_RUNS)),
        monteCarlo100kMedianMs: timed(9, () =>
          propagate(example.code, result, inputs, MONTE_CARLO_RUNS),
        ),
        sobolMedianMs: timed(9, () => varianceShares(example.code, result, inputs, 0)),
        sobolRuns: varianceShares(example.code, result, inputs, 0).evaluations,
      };
    })(),
  };
});
const report = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  runsPerExample: runs,
  warmupRuns: 20,
  hostLoad: loadavg(),
  note: 'Local measurements on a shared machine; core excludes worker messaging and DOM rendering. Monte Carlo timings cover sampling, column evaluation and summaries for every output; Sobol covers the (k + 2) × 16,384-run design and 100 bootstrap resamples for the first output.',
  rows,
};
await mkdir('shots', { recursive: true });
await writeFile('shots/core-performance.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
