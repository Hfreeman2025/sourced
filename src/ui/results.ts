import type { RunResult } from '../lang';
import { formatValue } from '../lang/runtime';
import { button, element, required } from './dom';
export function createResultView(
  select: (index: number) => void,
  trace: (index: number | undefined) => void,
) {
  const answer = required('#answer', HTMLDivElement),
    outputs = required('#outputs', HTMLDivElement),
    detail = required('#result-detail', HTMLDivElement);
  const rows: HTMLButtonElement[] = [];
  // Persistent, so a redraw of the answer never drops the current interval.
  const intervalSlot = element('div', 'answer-interval');
  /** Shrinks a long printed answer to its column; rerun once web fonts arrive. */
  const fit = () => {
    const amount = answer.querySelector('.answer-value');
    if (!(amount instanceof HTMLElement)) return;
    amount.style.fontSize = '';
    if (amount.scrollWidth > answer.clientWidth)
      amount.style.fontSize = `${((parseFloat(getComputedStyle(amount).fontSize) * answer.clientWidth) / amount.scrollWidth) * 0.98}px`;
  };
  const render = (
    result: RunResult,
    index: number,
    base: RunResult,
    scenario: boolean,
    spreads: { cited: string[]; assumed: string[] } = { cited: [], assumed: [] },
  ) => {
    const output = result.outputs[index];
    answer.replaceChildren();
    detail.replaceChildren();
    if (result.diagnostics.length || !output) {
      outputs.replaceChildren();
      rows.length = 0;
      const diagnostic = result.diagnostics[0];
      answer.className = 'answer empty-answer';
      answer.append(
        element('h3', '', diagnostic?.title ?? 'No calculation'),
        element('p', '', diagnostic?.message ?? 'Print a quantity to see its result.'),
      );
      if (diagnostic) {
        const hint = element('p', 'error-hint', diagnostic.hint);
        outputs.append(hint);
        detail.append(element('span', '', 'Results remain cleared until the error is resolved.'));
      }
      return;
    }
    // A previous error's hint or retry control must not survive a valid result.
    for (const stale of outputs.querySelectorAll(':scope > :not(.output-option)')) stale.remove();
    answer.className = 'answer';
    answer.append(
      element('h3', 'answer-label', output.label),
      element('div', 'answer-value', output.value ? formatValue(output.value) : output.text),
      intervalSlot,
    );
    while (rows.length > result.outputs.length) rows.pop()?.remove();
    result.outputs.forEach((item, i) => {
      let row = rows[i];
      if (!row) {
        row = button('', 'output-option', () => select(i));
        row.addEventListener('pointerenter', () => trace(i));
        row.addEventListener('pointerleave', () => trace(undefined));
        row.addEventListener('focus', () => trace(i));
        row.addEventListener('blur', () => trace(undefined));
        row.append(element('span'), element('strong'), element('small', 'output-interval'));
        rows.push(row);
        outputs.append(row);
      }
      row.classList.toggle('selected', i === index);
      row.setAttribute('aria-pressed', String(i === index));
      row.title = `${item.label}: ${item.value ? formatValue(item.value) : item.text}`;
      const label = row.firstElementChild,
        value = row.querySelector('strong');
      if (label) label.textContent = item.label;
      if (value) value.textContent = item.value ? formatValue(item.value) : item.text;
    });
    const baseline = base.outputs[index];
    if (
      scenario &&
      output.value &&
      baseline?.value &&
      output.label === baseline.label &&
      output.value.unit.symbol === baseline.value.unit.symbol
    ) {
      const delta = output.value.amount - baseline.value.amount;
      detail.append(
        element(
          'span',
          'scenario-comparison',
          `Base ${formatValue(baseline.value)} · change ${delta > 0 ? '+' : ''}${formatValue({ amount: delta, unit: output.value.unit })}`,
        ),
        element('span', 'scenario-note', 'Scenario; cited documents are unchanged.'),
      );
    }
    const receipt = element('div', 'lineage-receipt');
    receipt.append(element('h4', '', 'Selected result lineage'));
    const deps = output.value?.dependencies ?? [];
    const list = element('dl');
    for (const [prefix, title] of [
      ['source:', 'Sources'],
      ['assumption:', 'Assumptions'],
    ] as const) {
      const names = deps
        .filter((d) => d.startsWith(prefix))
        .map((d) => `${prefix === 'source:' ? '@' : ''}${d.slice(prefix.length)}`);
      list.append(element('dt', '', title), element('dd', '', names.join(' · ') || 'None'));
    }
    const spread = [
      spreads.cited.length ? `cited ${spreads.cited.join(' · ')}` : '',
      spreads.assumed.length ? `assumed ${spreads.assumed.join(' · ')}` : '',
    ].filter(Boolean);
    list.append(
      element('dt', '', 'Spreads'),
      element('dd', '', spread.join('; ') || 'None · exact'),
    );
    receipt.append(list);
    detail.append(receipt);
    if (result.outputs.length > 3)
      detail.append(
        element('span', 'result-receipt', `${result.outputs.length} results · scroll to select`),
      );
    requestAnimationFrame(fit);
  };
  return {
    render,
    fit,
    /** The selected result's 90% interval, directly under the printed answer. */
    interval(line: HTMLElement | undefined) {
      if ((line?.textContent ?? '') === intervalSlot.textContent) return;
      intervalSlot.replaceChildren(...(line ? [line] : []));
    },
    /** The 90% interval under each output, or nothing when it is exact. */
    intervals(texts: (string | undefined)[]) {
      rows.forEach((row, i) => {
        const slot = row.querySelector('.output-interval');
        if (slot) slot.textContent = texts[i] ?? '';
      });
    },
    clear(message: string) {
      answer.className = 'answer empty-answer';
      answer.replaceChildren(element('h3', '', 'Analysis unavailable'), element('p', '', message));
      outputs.replaceChildren();
      rows.length = 0;
      detail.replaceChildren();
    },
  };
}
