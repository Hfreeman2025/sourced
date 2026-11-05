import { run } from '../lang';
import { parse } from '../lang/parser';
import { collectInputs } from './inputs';
import {
  DEFAULT_SEED,
  MONTE_CARLO_RUNS,
  PREVIEW_RUNS,
  propagate,
  type Propagation,
  SOBOL_BASE,
  varianceShares,
} from './montecarlo';
import { contributingInputs, sensitivityRow, type SensitivityRow } from './sensitivity';
import { dependencyTokens } from './trace';
import { isRequest, type AnalysisRequest, type AnalysisResponse } from './protocol';
let generation = 0,
  latest: AnalysisRequest | undefined,
  busy = false;
const send = (value: AnalysisResponse) => self.postMessage(value);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// A drag sends one request per frame. Only the newest matters: superseded
// requests are dropped before any work starts, so a busy worker never builds
// a backlog that makes the distribution trail the number under the pointer.
self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isRequest(event.data)) {
    send({ phase: 'error', id: -1, message: 'Invalid analysis request.' });
    return;
  }
  latest = event.data;
  generation++;
  if (!busy) void pump();
};
async function pump() {
  busy = true;
  while (latest) {
    const request = latest;
    latest = undefined;
    await analyse(request, generation);
  }
  busy = false;
}
/** The last refined pass. It depends only on the code and the seed, not on
 * which output is selected, so selecting another output reuses it. */
let cached: { source: string; seed: number; propagation: Propagation } | undefined;
async function analyse(request: AnalysisRequest, current: number) {
  const seed = request.seed ?? DEFAULT_SEED;
  const stale = () => generation !== current;
  try {
    const result = run(request.source),
      inputs = collectInputs(request.source);
    const traces = result.outputs.map((_, i) => dependencyTokens(request.source, result, i));
    send({ phase: 'result', id: request.id, result, inputs, traces });
    if (result.diagnostics.length) {
      send({ phase: 'sensitivity', id: request.id, rows: [], total: 0 });
      return;
    }
    const program = parse(request.source);
    const reusable =
      cached?.source === request.source && cached.seed === seed ? cached.propagation : undefined;
    // A fast first pass on every new program, so a drag reshapes the
    // distribution at once. Its runs are the first runs of the refined pass.
    let started = performance.now();
    const preview =
      reusable ?? propagate(request.source, result, inputs, PREVIEW_RUNS, seed, program);
    send({
      phase: 'distribution',
      id: request.id,
      refined: Boolean(reusable) || !preview.uncertain,
      propagation: preview,
      elapsedMs: reusable ? 0 : performance.now() - started,
    });
    const numeric = Boolean(result.outputs[request.outputIndex]?.value);
    const contributing = numeric ? contributingInputs(result, request.outputIndex, inputs) : [],
      rows: SensitivityRow[] = [];
    for (const input of contributing) {
      if (rows.length % 4 === 0) {
        await pause();
        if (rows.length && rows.length % 16 === 0)
          send({
            phase: 'progress',
            id: request.id,
            completed: rows.length,
            total: contributing.length,
          });
      }
      if (stale()) return;
      rows.push(
        sensitivityRow(request.source, input, result, request.outputIndex, request.fraction),
      );
    }
    if (stale()) return;
    send({
      phase: 'sensitivity',
      id: request.id,
      rows: rows.sort((a, b) => b.impact - a.impact || a.input.start - b.input.start),
      total: contributing.length,
    });
    if (!reusable && preview.uncertain) {
      // Refine only once the input stops changing: any newer request wins here.
      await pause();
      if (stale()) return;
      started = performance.now();
      const refined = propagate(request.source, result, inputs, MONTE_CARLO_RUNS, seed, program);
      cached = { source: request.source, seed, propagation: refined };
      send({
        phase: 'distribution',
        id: request.id,
        refined: true,
        propagation: refined,
        elapsedMs: performance.now() - started,
      });
    }
    if (!numeric) return;
    await pause();
    if (stale()) return;
    started = performance.now();
    const shares = varianceShares(
      request.source,
      result,
      inputs,
      request.outputIndex,
      SOBOL_BASE,
      seed,
      program,
    );
    if (stale()) return;
    send({ phase: 'shares', id: request.id, shares, elapsedMs: performance.now() - started });
  } catch (error) {
    send({
      phase: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : 'Analysis failed.',
    });
  }
}
