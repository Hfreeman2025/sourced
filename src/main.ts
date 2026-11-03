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
import { percent, renderSensitivity, type ShareState } from './ui/sensitivity';
import { createResultView } from './ui/results';
import { reference } from './ui/reference';
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
const exampleTabs = required('#examples', HTMLDivElement),
  exampleSelect = required('#example-select', HTMLSelectElement);
const inputSelect = required('#input-select', HTMLSelectElement),
  quantityInput = required('#quantity-input', HTMLInputElement);
const baseline = examples.map((example) => run(example.code)),
  drafts = new Map<string, string>();
let exampleIndex = 0,
  outputIndex = 0,
  selectedInput = '',
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
required('#editor', HTMLDivElement).replaceChildren();
const editor = createEditor(
  required('#editor', HTMLDivElement),
  source,
  (changed) => {
    source = changed;
    if (worker && !failed) {
      document.body.classList.add('analysis-pending');
      required('#check-status', HTMLSpanElement).textContent = 'Checking…';
      required('#result-state', HTMLSpanElement).textContent = 'Checking · previous values';
      required('#sensitivity-status', HTMLSpanElement).textContent = 'Recomputing perturbations…';
    }
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
      selectedInput = input.id;
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
function announce(message: string) {
  const toast = required('#toast', HTMLSpanElement);
  toast.textContent = message;
  toast.title = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 1800);
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
  document.body.classList.add('analysis-pending');
  required('#check-status', HTMLSpanElement).textContent = 'Checking…';
  required('#result-state', HTMLSpanElement).textContent = result.outputs.length
    ? 'Checking · previous values'
    : 'Checking calculation';
  required('#sensitivity-status', HTMLSpanElement).textContent = 'Recomputing perturbations…';
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
/** Inputs whose declared spread reaches the selected result, by provenance. */
function spreadsFor(index: number) {
  const reaching = result.diagnostics.length
    ? []
    : contributingInputs(result, index, inputs).filter((input) => input.uncertainty);
  return {
    reaching,
    cited: [...new Set(reaching.flatMap((input) => (input.uncertainty?.source ? [`@${input.uncertainty.source}`] : [])))],
    assumed: reaching.filter((input) => !input.uncertainty?.source).map((input) => input.label),
  };
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
    distribution: result.diagnostics.length || !output?.value ? null : current?.outputs[outputIndex],
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
function shareFinding(state: VarianceShares, nudges: SensitivityRow[]): string | undefined {
  if (!state.varies || !state.rows.length) return undefined;
  const label = (id: string) => inputs.find((input) => input.id === id);
  const ranked = [...state.rows].sort((a, b) => b.first - a.first);
  const top = ranked[0];
  if (!top) return undefined;
  let cited = 0,
    assumed = 0,
    alone = 0;
  for (const row of state.rows) {
    alone += Math.max(0, row.first);
    if (label(row.inputId)?.uncertainty?.source) cited += Math.max(0, row.first);
    else assumed += Math.max(0, row.first);
  }
  const parts = [`Knowing ${label(top.inputId)?.label ?? 'the top input'} exactly would remove about ${percent(top.first)} of the variance.`];
  const variation = `±${Math.round(Number(required('#fraction', HTMLSelectElement).value) * 100)}%`;
  const nudged = nudges[0];
  const largest = nudged?.impact ?? 0;
  if (cited > 0 && assumed > 0)
    parts.push(`Cited spreads account for ${percent(cited)}, assumed spreads ${percent(assumed)}.`);
  else if (nudged && !nudged.input.uncertainty && largest > 0)
    parts.push(
      `A ${variation} nudge to ${nudged.input.label} moves the result most, but it has no declared uncertainty.`,
    );
  else if (nudges.length > 1 && nudges.every((row) => Math.abs(row.impact - largest) <= largest * 0.01))
    parts.push(`Every ${variation} nudge moves the result equally; only the uncertainty differs.`);
  const interaction = 1 - alone;
  if (interaction >= 0.015) parts.push(`Interactions: ${percent(interaction)}.`);
  return parts.join(' ');
}
function drawSensitivity() {
  const output = result.outputs[outputIndex];
  if (!tornado || tornado.id !== requestId) return;
  if (result.diagnostics.length || !output?.value) {
    required('#sensitivity', HTMLDivElement).replaceChildren(
      element(
        'p',
        'panel-empty',
        result.diagnostics.length
          ? 'Resolve the calculation errors to inspect sensitivity.'
          : 'Print a quantity to analyse its contributing inputs.',
      ),
    );
    required('#sensitivity-status', HTMLSpanElement).textContent = result.diagnostics.length
      ? 'Not calculated while errors remain.'
      : 'No numeric result to perturb.';
    return;
  }
  const { reaching } = spreadsFor(outputIndex);
  const ready = shares && sharesId === requestId ? shares : undefined;
  const state: ShareState = !reaching.length
    ? { status: 'none', rows: new Map(), varies: false }
    : ready
      ? {
          status: 'ready',
          rows: new Map(ready.rows.map((row) => [row.inputId, row])),
          varies: ready.varies,
          finding: shareFinding(ready, tornado.rows),
        }
      : { status: 'pending', rows: new Map(), varies: false };
  renderSensitivity(
    required('#sensitivity', HTMLDivElement),
    tornado.rows,
    output.value.unit.symbol,
    (id) => {
      selectedInput = id;
      updateInputs(inputs);
      const input = inputs.find((i) => i.id === id);
      if (input) editor.reveal(input);
      quantityInput.focus({ preventScroll: true });
    },
    (id) => {
      const input = inputs.find((i) => i.id === id);
      editor.trace(input ? [input.literal] : []);
    },
    false,
    state,
  );
  required('#sensitivity-status', HTMLSpanElement).textContent =
    state.status === 'ready' && ready
      ? `${tornado.total} inputs · one at a time · Sobol from ${ready.evaluations.toLocaleString('en-GB')} runs`
      : state.status === 'pending'
        ? `${tornado.total} inputs · one at a time · estimating variance shares…`
        : `${tornado.total} inputs · one at a time · actual program reruns`;
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
    spreadsFor(outputIndex),
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
  resultView.render(result, index, original, source !== examples[exampleIndex]?.code, spreadsFor(index));
  drawDistribution();
  drawLineage();
  requestAnalysis();
}
function updateInputs(next: InputLiteral[]) {
  inputs = next;
  if (!inputs.some((i) => i.id === selectedInput)) selectedInput = inputs[0]?.id ?? '';
  const signature = inputs.map((i) => i.id).join('|');
  if (inputSelect.dataset.signature !== signature) {
    inputSelect.replaceChildren(
      ...inputs.map((input) => {
        const option = element('option', '', input.label);
        option.value = input.id;
        return option;
      }),
    );
    inputSelect.dataset.signature = signature;
  }
  inputSelect.value = selectedInput;
  const input = inputs.find((i) => i.id === selectedInput);
  quantityInput.disabled = !input;
  inputSelect.disabled = !input;
  if (input) {
    if (document.activeElement !== quantityInput) quantityInput.value = String(input.value);
    quantityInput.step = String(input.step);
    required('#input-unit', HTMLSpanElement).textContent = input.unit || 'ratio';
  } else {
    quantityInput.value = '';
    required('#input-unit', HTMLSpanElement).textContent = '';
  }
}
function setExample(index: number) {
  const example = examples[index];
  if (!example) return;
  exampleIndex = index;
  outputIndex = 0;
  selectedInput = '';
  traceIndex = undefined;
  propagation = undefined;
  propagationSource = '';
  shares = undefined;
  source = drafts.get(example.id) ?? example.code;
  exampleTabs.querySelectorAll('button').forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
  });
  exampleSelect.value = String(index);
  required('#filename', HTMLSpanElement).textContent = example.filename;
  required('#example-note', HTMLSpanElement).textContent = example.note;
  editor.load(source);
  setEditState();
  updateInputs(collectInputs(source));
  requestAnalysis();
}
examples.forEach((example, index) => {
  const tab = button(example.title, 'example-tab', () => setExample(index));
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', 'workbench');
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? examples.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + examples.length) % examples.length;
    setExample(next);
    exampleTabs.querySelectorAll('button')[next]?.focus();
  });
  exampleTabs.append(tab);
  const option = element('option', '', example.title);
  option.value = String(index);
  exampleSelect.append(option);
});
exampleSelect.addEventListener('change', () => setExample(Number(exampleSelect.value)));
inputSelect.addEventListener('change', () => {
  selectedInput = inputSelect.value;
  updateInputs(inputs);
  const input = inputs.find((i) => i.id === selectedInput);
  if (input) editor.reveal(input);
});
required('#adjust-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  quantityInput.blur();
});
quantityInput.addEventListener('input', () => {
  const input = inputs.find((i) => i.id === selectedInput);
  const value = quantityInput.valueAsNumber;
  const valid = Number.isFinite(value);
  quantityInput.setAttribute('aria-invalid', String(!valid));
  required('#quantity-error', HTMLSpanElement).textContent = valid ? '' : 'Enter a finite value.';
  if (input && valid) editor.setCode(replaceInput(source, input, value));
});
quantityInput.addEventListener('blur', () => {
  if (!Number.isFinite(quantityInput.valueAsNumber)) updateInputs(inputs);
});
quantityInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    quantityInput.value = String(inputs.find((i) => i.id === selectedInput)?.value ?? '');
    quantityInput.removeAttribute('aria-invalid');
    required('#quantity-error', HTMLSpanElement).textContent = '';
    quantityInput.blur();
  }
});
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
required('#copy-code', HTMLButtonElement).addEventListener('click', () => {
  if (!navigator.clipboard) {
    announce('Select the code to copy it; clipboard access is unavailable.');
    return;
  }
  navigator.clipboard
    .writeText(source)
    .then(() => announce('Code copied.'))
    .catch(() => announce('Clipboard unavailable. Select the code to copy it.'));
});
const guide = required('#guide-dialog', HTMLDialogElement),
  javascript = required('#js-dialog', HTMLDialogElement);
required('#reference', HTMLDivElement).innerHTML = reference;
required('#guide-open', HTMLButtonElement).addEventListener('click', () => guide.showModal());
required('#js-open', HTMLButtonElement).addEventListener('click', () => {
  required('#compiled-code', HTMLPreElement).textContent = result.diagnostics.length
    ? 'Resolve the errors before compiling JavaScript.'
    : compile(parse(source));
  javascript.showModal();
});
for (const dialog of [guide, javascript]) {
  dialog.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      dialog.close();
  });
}
function analysisTab(lineage: boolean) {
  document.body.classList.toggle('show-lineage', lineage);
  required('#sensitivity-tab', HTMLButtonElement).setAttribute('aria-selected', String(!lineage));
  required('#lineage-tab', HTMLButtonElement).setAttribute('aria-selected', String(lineage));
}
required('#sensitivity-tab', HTMLButtonElement).addEventListener('click', () => analysisTab(false));
required('#lineage-tab', HTMLButtonElement).addEventListener('click', () => analysisTab(true));
for (const id of ['sensitivity-tab', 'lineage-tab'])
  required(`#${id}`, HTMLButtonElement).addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      analysisTab(id === 'sensitivity-tab');
      required(
        id === 'sensitivity-tab' ? '#lineage-tab' : '#sensitivity-tab',
        HTMLButtonElement,
      ).focus();
    }
  });
function networkStatus() {
  document.body.classList.toggle('offline', !navigator.onLine);
  required('#network-status', HTMLSpanElement).textContent = navigator.onLine
    ? 'Local calculation'
    : 'Offline · calculations available';
}
window.addEventListener('online', networkStatus);
window.addEventListener('offline', networkStatus);
networkStatus();
document.querySelectorAll<HTMLButtonElement>('.workspace button[disabled]').forEach((node) => {
  node.disabled = false;
});
exampleSelect.disabled = false;
startWorker();
setExample(0);
