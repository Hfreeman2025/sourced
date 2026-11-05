import type { InputLiteral } from '../analysis/inputs';
import type { VarianceShares } from '../analysis/montecarlo';
import type { SensitivityRow } from '../analysis/sensitivity';
import { spreadsFor } from '../analysis/spreads';
import type { RunResult } from '../lang';
import { element, required } from './dom';
import { shareFinding } from './finding';
import { renderSensitivity, type ShareState } from './sensitivity';

/** The Sensitivity panel for one result: the tornado, the variance shares beside
 * it, the sentence above them and the status line below. */
export function showSensitivity(view: {
  result: RunResult;
  outputIndex: number;
  inputs: InputLiteral[];
  tornado: { rows: SensitivityRow[]; total: number };
  /** The Sobol estimate for this request, or undefined while it is computed. */
  shares: VarianceShares | undefined;
  /** The nudge size as the sentence names it, such as "±10%". */
  variation: string;
  select: (id: string) => void;
  highlight: (id: string | undefined) => void;
}) {
  const { result, outputIndex, inputs, tornado, shares } = view;
  const container = required('#sensitivity', HTMLDivElement),
    status = required('#sensitivity-status', HTMLSpanElement);
  const output = result.outputs[outputIndex];
  if (result.diagnostics.length || !output?.value) {
    container.replaceChildren(
      element(
        'p',
        'panel-empty',
        result.diagnostics.length
          ? 'Resolve the calculation errors to inspect sensitivity.'
          : 'Print a quantity to analyse its contributing inputs.',
      ),
    );
    status.textContent = result.diagnostics.length
      ? 'Not calculated while errors remain.'
      : 'No numeric result to perturb.';
    return;
  }
  const { reaching } = spreadsFor(result, inputs, outputIndex);
  const state: ShareState = !reaching.length
    ? { status: 'none', rows: new Map(), varies: false }
    : shares
      ? {
          status: 'ready',
          rows: new Map(shares.rows.map((row) => [row.inputId, row])),
          varies: shares.varies,
          finding: shareFinding(shares, tornado.rows, inputs, view.variation),
        }
      : { status: 'pending', rows: new Map(), varies: false };
  renderSensitivity(
    container,
    tornado.rows,
    output.value.unit.symbol,
    view.select,
    view.highlight,
    false,
    state,
  );
  status.textContent =
    state.status === 'ready' && shares
      ? `${tornado.total} inputs · one at a time · Sobol from ${shares.evaluations.toLocaleString('en-GB')} runs`
      : state.status === 'pending'
        ? `${tornado.total} inputs · one at a time · estimating variance shares…`
        : `${tornado.total} inputs · one at a time · actual program reruns`;
}
