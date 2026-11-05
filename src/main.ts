import './style.css';
import CalculationWorker from './analysis/worker.ts?worker&inline';
import { compile, parse, run, type RunResult } from './lang';
import { canEvaluateInFrame } from './analysis/frame-budget';
import { dependencyTokens } from './analysis/trace';
import type { AnalysisResponse } from './analysis/protocol';
import { collectInputs, replaceInput, type InputLiteral } from './analysis/inputs';
import { examples } from './examples';
import { createEditor } from './ui/editor';
import { element, button, required } from './ui/dom';
import { renderLineage } from './ui/lineage';
import { showSensitivity } from './ui/sensitivity-panel';
import { createResultView } from './ui/results';
import { reference } from './ui/reference';
import { createAdjustBar } from './ui/adjust';
import {
  announce,
  installAnalysisTabs,
  installCopyCode,
  installDialogs,
  installExampleChooser,
  installNetworkStatus,
} from './ui/chrome';
import { spreadsFor } from './analysis/spreads';
import { decimalsFor, formatAt, intervalLine, renderDistribution } from './ui/distribution';
import { contributingInputs, type SensitivityRow } from './analysis/sensitivity';
import {
  DEFAULT_SEED,
  PREVIEW_RUNS,
  propagate,
  type Propagation,
  type VarianceShares,
} from './analysis/montecarlo';
performance.mark('sourced-module-ready');
import type { Span } from './lang/types';
const baseline = examples.map((example) => run(example.code)),
  drafts = new Map<string, string>();
let exampleIndex = 0,
  outputIndex = 0,
  source = examples[0]?.code ?? '',
  inputs: InputLiteral[] = [],
  traces: Span[][] = [],
  result: RunResult = { outputs: [], nodes: [], bindings: {}, diagnostics: [] };
let analysisSource = source;
let worker: Worker | undefined,
  requestId = 0,
  frame = 0,
  scrubbing = false,
  traceIndex: number | undefined,
  failed = false;
// Monte Carlo state. The previous distribution stays on screen, dimmed,
// until the worker's pass for the current program replaces it.
let seed = DEFAULT_SEED,
  propagation: Propagation | undefined,
  propagationSource = '',
  refined = false,
  shares: VarianceShares | undefined,
  sharesId = -1,
  tornado: { id: number; rows: SensitivityRow[]; total: number } | undefined;
performance.mark('sourced-examples-checked');
const resultView = createResultView(selectOutput, traceOutput);
const adjust = createAdjustBar({
  reveal: (input) => editor.reveal(input),
  apply: (input, value) => editor.setCode(replaceInput(source, input, value)),
});
required('#editor', HTMLDivElement).replaceChildren();
const editor = createEditor(
  required('#editor', HTMLDivElement),
  source,
  (changed) => {
    source = changed;
    if (worker && !failed) showPending(true);
    const example = examples[exampleIndex];
    if (example) drafts.set(example.id, source);
    traces = [];
    traceIndex = undefined;
    required('#editor', HTMLDivElement).classList.remove('has-trace');
    required('#trace-notice', HTMLSpanElement).textContent =
      'Source references stay attached to every calculation.';
    setEditState();
    updateInputs(collectInputs(source));
    schedule();
  },
  () => requestAnalysis(),
  {
    select(input) {
      adjust.choose(input.id);
      updateInputs(collectInputs(source));
    },
    gesture(active, input, value) {
      scrubbing = active;
      const feedback = required('#gesture-feedback', HTMLDivElement);
      feedback.hidden = !active;
      feedback.textContent = `${input.label}: ${input.value} → ${value}${input.unit ? ` ${input.unit}` : ''}`;
      if (!active) requestAnalysis();
    },
  },
);
performance.mark('sourced-editor-ready');
/** Marks the panels as rechecking; earlier values stay on screen, dimmed. */
function showPending(previous: boolean) {
  document.body.classList.add('analysis-pending');
  required('#check-status', HTMLSpanElement).textContent = 'Checking…';
  required('#result-state', HTMLSpanElement).textContent = previous
    ? 'Checking · previous values'
    : 'Checking calculation';
  required('#sensitivity-status', HTMLSpanElement).textContent = 'Recomputing perturbations…';
}
function setEditState() {
  const changed = source !== examples[exampleIndex]?.code;
  required('#edit-state', HTMLSpanElement).textContent = changed
    ? 'What-if scenario'
    : 'Original example';
  required('#edit-state', HTMLSpanElement).classList.toggle('changed', changed);
}
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    requestAnalysis();
  });
}
function unavailable(message: string) {
  failed = true;
  worker?.terminate();
  worker = undefined;
  requestId++;
  document.body.classList.add('no-analysis');
  required('#sensitivity-status', HTMLSpanElement).textContent = 'Not calculated.';
  required('#lineage-summary', HTMLSpanElement).textContent = 'No checked quantity';
  required('#check-status', HTMLSpanElement).textContent = 'Analysis unavailable';
  required('#result-state', HTMLSpanElement).textContent = 'No checked result';
  resultView.clear(message);
  required('#outputs', HTMLDivElement).append(
    typeof Worker === 'undefined'
      ? button('Language reference', 'retry-button', () =>
          required('#guide-dialog', HTMLDialogElement).showModal(),
        )
      : button('Retry local analysis', 'retry-button', () => {
          startWorker();
          requestAnalysis();
        }),
  );
  for (const id of ['sensitivity', 'lineage'])
    required(`#${id}`, HTMLDivElement).replaceChildren(
      element('p', 'panel-empty', 'Local analysis is unavailable. Your code remains editable.'),
    );
  document.body.classList.remove('analysis-pending');
}
function startWorker() {
  worker?.terminate();
  failed = false;
  try {
    if (typeof Worker === 'undefined')
      throw new Error(
        'This browser does not support local workers. Use a current browser to run calculations.',
      );
    worker = new CalculationWorker();
    worker.onerror = (event) => {
      event.preventDefault();
      unavailable(
        'The local calculation worker could not start. Retry without reloading your code.',
      );
    };
    worker.onmessageerror = () => unavailable('The local analysis response could not be read.');
    worker.onmessage = (event: MessageEvent<AnalysisResponse>) => receive(event.data);
  } catch (error) {
    unavailable(
      error instanceof Error ? error.message : 'The local calculation worker could not start.',
    );
  }
}
function requestAnalysis() {
  if (failed || !worker) return;
  cancelAnimationFrame(frame);
  frame = 0;
  const id = ++requestId;
  if (!performance.getEntriesByName('sourced-analysis-requested').length)
    performance.mark('sourced-analysis-requested');
  analysisSource = source;
  showPending(result.outputs.length > 0);
  worker.postMessage({
    id,
    source,
    outputIndex,
    fraction: Number(required('#fraction', HTMLSelectElement).value),
    seed,
  });
  if (canEvaluateInFrame(source)) {
    const checked = run(source),
      collected = collectInputs(source);
    // Small programs also sample their preview in this frame, so the
    // distribution moves in lockstep with the number under the pointer. The
    // worker repeats it with the same seed (identical runs) and then refines.
    if (!checked.diagnostics.length && propagationSource !== source) {
      const preview = propagate(source, checked, collected, PREVIEW_RUNS, seed);
      propagation = preview;
      refined = !preview.uncertain;
      propagationSource = source;
    }
    publishResult(
      checked,
      collected,
      checked.outputs.map((_, i) => dependencyTokens(source, checked, i)),
    );
  }
}
function receive(message: AnalysisResponse) {
  if (message.id !== requestId || analysisSource !== source) return;
  if (message.phase === 'error') {
    unavailable(message.message);
    return;
  }
  if (message.phase === 'progress') {
    required('#sensitivity-status', HTMLSpanElement).textContent =
      `Checking ${message.completed} / ${message.total} inputs…`;
    return;
  }
  if (message.phase === 'distribution') {
    // A preview never replaces a pass already drawn for this code and seed:
    // it repeats the in-frame preview exactly, or would undo a refinement.
    if (!message.refined && propagation && propagationSource === source) return;
    propagation = message.propagation;
    refined = message.refined;
    propagationSource = source;
    drawDistribution();
    // Timing marks for the measurement script: worker compute time and runs.
    performance.mark(refined ? 'sourced-distribution-refined' : 'sourced-distribution-preview', {
      detail: { runs: message.propagation.runs, workerMs: message.elapsedMs },
    });
    return;
  }
  if (message.phase === 'shares') {
    shares = message.shares;
    sharesId = message.id;
    drawSensitivity();
    performance.mark('sourced-shares', {
      detail: { evaluations: message.shares.evaluations, workerMs: message.elapsedMs },
    });
    return;
  }
  if (message.phase === 'sensitivity') {
    tornado = { id: message.id, rows: message.rows, total: message.total };
    drawSensitivity();
    // An exact result's suggestion targets the most influential input.
    drawDistribution();
    return;
  }
  publishResult(message.result, message.inputs, message.traces);
}
let drawnDistribution: { key: string; propagation?: Propagation } | undefined;
function drawDistribution() {
  const container = required('#distribution', HTMLDivElement);
  const output = result.outputs[outputIndex];
  const current =
    propagation && propagation.outputs.length === result.outputs.length ? propagation : undefined;
  // A pass for different code is drawn faded, without its interval: it is the
  // previous program's distribution until this program's pass arrives.
  const stale = Boolean(current) && propagationSource !== source;
  const ranked =
    tornado?.id === requestId
      ? tornado.rows.map((row) => row.input)
      : contributingInputs(result, outputIndex, inputs);
  const target = ranked.find((input) => input.role === 'value' && input.value !== 0);
  // Redraw only when something drawn would change. Rebuilding an identical
  // figure above a scrolled page makes Firefox fight its own scroll anchoring.
  const key = [
    outputIndex,
    output?.label,
    Boolean(output?.value),
    result.diagnostics.length,
    refined,
    current?.seed,
    stale,
    container.clientWidth,
    target?.id ?? '',
    target?.literal.end ?? '',
  ].join('|');
  resultView.intervals(
    result.outputs.map((item, i) => {
      const summary = stale ? undefined : current?.outputs[i]?.summary;
      if (!summary || !item.value) return undefined;
      const decimals = decimalsFor(summary.p95 - summary.p5);
      return `90%: ${formatAt(summary.p5, '', decimals)}–${formatAt(summary.p95, item.value.unit.symbol, decimals)}`;
    }),
  );
  resultView.interval(
    result.diagnostics.length || !output?.value || stale
      ? undefined
      : intervalLine(current?.outputs[outputIndex]),
  );
  container.classList.toggle('is-stale', stale);
  if (drawnDistribution?.key === key && drawnDistribution.propagation === current) return;
  drawnDistribution = { key, propagation: current };
  renderDistribution(container, {
    label: output?.label ?? 'result',
    distribution:
      result.diagnostics.length || !output?.value ? null : current?.outputs[outputIndex],
    refined: refined && !stale,
    runs: current?.runs ?? 0,
    seed: current?.seed ?? seed,
    pending: !current && !result.diagnostics.length,
    stale,
    suggestion: target
      ? {
          text: `${target.label} ~ ±10% assumed`,
          apply: () => {
            editor.insert(target.literal.end, ' ~ ±10% assumed');
            announce(`Added an assumed ±10% spread to ${target.label}.`);
          },
        }
      : undefined,
    reseed: () => {
      seed = (seed % 9999) + 1;
      propagationSource = '';
      requestAnalysis();
    },
  });
}
/** The tornado's nudge, as the sentence above the table names it: "±10%". */
function drawSensitivity() {
  if (!tornado || tornado.id !== requestId) return;
  showSensitivity({
    result,
    outputIndex,
    inputs,
    tornado,
    shares: shares && sharesId === requestId ? shares : undefined,
    variation: `±${Math.round(Number(required('#fraction', HTMLSelectElement).value) * 100)}%`,
    select: (id) => {
      adjust.choose(id);
      updateInputs(inputs);
      const input = inputs.find((i) => i.id === id);
      if (input) editor.reveal(input);
      adjust.focus();
    },
    highlight: (id) => {
      const input = inputs.find((i) => i.id === id);
      editor.trace(input ? [input.literal] : []);
    },
  });
}
function publishResult(next: RunResult, nextInputs: InputLiteral[], nextTraces: Span[][]) {
  if (!performance.getEntriesByName('sourced-data-ready').length)
    performance.mark('sourced-data-ready');
  result = next;
  document.body.classList.toggle(
    'no-analysis',
    result.diagnostics.length > 0 || !result.outputs[outputIndex]?.value,
  );
  inputs = nextInputs;
  traces = nextTraces;
  if (outputIndex >= result.outputs.length && outputIndex !== 0) {
    outputIndex = 0;
    requestAnalysis();
    return;
  }
  editor.diagnostics(result.diagnostics);
  document.body.classList.remove('analysis-pending');
  required('#check-status', HTMLSpanElement).textContent = result.diagnostics.length
    ? `${result.diagnostics.length} error${result.diagnostics.length === 1 ? '' : 's'}`
    : 'Units checked';
  required('#check-status', HTMLSpanElement).className = result.diagnostics.length
    ? 'has-error'
    : 'is-valid';
  required('#result-state', HTMLSpanElement).textContent = result.diagnostics.length
    ? 'Results cleared'
    : scrubbing
      ? 'Recomputed while dragging'
      : 'Checked locally';
  const original = baseline[exampleIndex] ?? {
    outputs: [],
    nodes: [],
    bindings: {},
    diagnostics: [],
  };
  resultView.render(
    result,
    outputIndex,
    original,
    source !== examples[exampleIndex]?.code,
    spreadsFor(result, inputs, outputIndex),
  );
  updateInputs(inputs);
  drawDistribution();
  drawLineage();
  if (traceIndex !== undefined) traceOutput(traceIndex);
  if (!performance.getEntriesByName('sourced-meaningful-paint').length)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => performance.mark('sourced-meaningful-paint')),
    );
}
function drawLineage() {
  renderLineage(
    required('#lineage', HTMLDivElement),
    result,
    outputIndex,
    (node) => {
      editor.reveal(node.span);
      editor.view.focus();
    },
    source,
  );
  const output = result.outputs[outputIndex];
  required('#lineage-summary', HTMLSpanElement).textContent = output?.value
    ? `${output.value.dependencies.length} origins · full calculation`
    : 'No checked quantity';
}
function traceOutput(index: number | undefined) {
  traceIndex = index;
  editor.trace(index === undefined ? [] : (traces[index] ?? []));
  required('#trace-notice', HTMLSpanElement).textContent =
    index === undefined
      ? 'Source references stay attached to every calculation.'
      : `Highlighted code for ${result.outputs[index]?.label ?? 'result'}`;
  required('#editor', HTMLDivElement).classList.toggle('has-trace', index !== undefined);
}
function selectOutput(index: number) {
  outputIndex = index;
  const original = baseline[exampleIndex] ?? result;
  resultView.render(
    result,
    index,
    original,
    source !== examples[exampleIndex]?.code,
    spreadsFor(result, inputs, index),
  );
  drawDistribution();
  drawLineage();
  requestAnalysis();
}
function updateInputs(next: InputLiteral[]) {
  inputs = next;
  adjust.show(next);
}
function setExample(index: number) {
  const example = examples[index];
  if (!example) return;
  exampleIndex = index;
  outputIndex = 0;
  adjust.choose('');
  traceIndex = undefined;
  propagation = undefined;
  propagationSource = '';
  shares = undefined;
  source = drafts.get(example.id) ?? example.code;
  chooser.mark(index);
  required('#filename', HTMLSpanElement).textContent = example.filename;
  required('#example-note', HTMLSpanElement).textContent = example.note;
  editor.load(source);
  setEditState();
  updateInputs(collectInputs(source));
  requestAnalysis();
}
const chooser = installExampleChooser(
  examples.map((example) => example.title),
  setExample,
);
required('#fraction', HTMLSelectElement).addEventListener('change', requestAnalysis);
required('#reset-code', HTMLButtonElement).addEventListener('click', () => {
  const example = examples[exampleIndex];
  if (!example) return;
  drafts.delete(example.id);
  editor.setCode(example.code);
  source = example.code;
  setEditState();
  requestAnalysis();
});
installCopyCode(() => source);
installDialogs(reference, () =>
  result.diagnostics.length
    ? 'Resolve the errors before compiling JavaScript.'
    : compile(parse(source)),
);
installAnalysisTabs();
installNetworkStatus();
document.querySelectorAll<HTMLButtonElement>('.workspace button[disabled]').forEach((node) => {
  node.disabled = false;
});
chooser.enable();
startWorker();
setExample(0);
// Plex swaps in after first paint; refit the printed answer to its real width.
document.fonts?.ready.then(() => resultView.fit());
