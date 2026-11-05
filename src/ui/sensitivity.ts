import { formatValue } from '../lang/runtime';
import type { SensitivityRow } from '../analysis/sensitivity';
import type { SobolRow } from '../analysis/montecarlo';
import { button, element } from './dom';
/** Variance shares beside the tornado. `none`: no declared uncertainty
 * reaches this result, so there is no variance to share. */
export interface ShareState {
  status: 'none' | 'pending' | 'ready';
  rows: Map<string, SobolRow>;
  varies: boolean;
  finding?: string;
}
export const percent = (share: number): string => {
  if (!Number.isFinite(share)) return '—';
  const value = share * 100;
  if (value <= 0) return '0%';
  return value < 0.5 ? '<1%' : `${Math.round(Math.min(100, value))}%`;
};
function shareCell(row: SensitivityRow, state: ShareState | undefined): HTMLElement {
  const cell = element('span', 'share');
  if (!state || state.status === 'none') return cell;
  if (state.status === 'pending') {
    cell.append(element('span', 'share-note', 'estimating…'));
    return cell;
  }
  const share = state.rows.get(row.input.id);
  if (!share) {
    cell.append(element('span', 'share-note', 'fixed'));
    cell.title = 'No declared uncertainty: this input does not vary between runs.';
    return cell;
  }
  if (!state.varies) {
    cell.append(element('span', 'share-note', 'no variance'));
    return cell;
  }
  const clamp = (value: number) => Math.min(100, Math.max(0, value * 100));
  const plot = element('span', 'share-plot');
  const alone = element('span', 'share-first'),
    joint = element('span', 'share-joint'),
    whisker = element('span', 'share-ci');
  alone.style.width = `${clamp(share.first)}%`;
  joint.style.left = `${clamp(share.first)}%`;
  joint.style.width = `${Math.max(0, clamp(share.total) - clamp(share.first))}%`;
  whisker.style.left = `${clamp(share.totalLow)}%`;
  whisker.style.width = `${Math.max(0, clamp(share.totalHigh) - clamp(share.totalLow))}%`;
  plot.append(alone, joint, whisker);
  const interaction = share.total - share.first;
  const value = element('span', 'share-value', percent(share.first));
  if (interaction >= 0.005)
    value.append(element('span', 'share-joint-value', ` +${percent(interaction)}`));
  cell.append(plot, value);
  cell.title = `Alone: ${percent(share.first)} (95% bootstrap ${percent(share.firstLow)}–${percent(share.firstHigh)}). With interactions: ${percent(share.total)} (${percent(share.totalLow)}–${percent(share.totalHigh)}).`;
  return cell;
}
export function renderSensitivity(
  container: HTMLElement,
  rows: SensitivityRow[],
  unit: string,
  select: (id: string) => void,
  highlight: (id: string | undefined) => void,
  all = false,
  shares?: ShareState,
) {
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.getAttribute('data-row')
      : null;
  container.replaceChildren();
  if (!rows.length) {
    container.append(
      element(
        'p',
        'panel-empty',
        'No contributing numeric inputs. Print a quantity to analyse it.',
      ),
    );
    return;
  }
  const withShares = Boolean(shares && shares.status !== 'none');
  container.classList.toggle('has-shares', withShares);
  // The finding's line is reserved while the shares are estimated, so the
  // table does not move when the sentence arrives.
  if (withShares)
    container.append(
      shares?.finding
        ? element('p', 'share-finding', shares.finding)
        : element('p', 'share-finding pending', 'Estimating which uncertainty matters…'),
    );
  const maximum = Math.max(...rows.map((row) => row.impact)) || 1;
  const axis = element('div', 'tornado-axis');
  axis.append(
    element('span', '', 'Input'),
    element('span', '', '− result change +'),
    element('span', '', unit || 'ratio'),
  );
  if (withShares) axis.append(element('span', 'share-heading', 'Share of variance'));
  container.append(axis);
  const limit = all ? rows.length : Math.min(rows.length, 48);
  for (const row of rows.slice(0, limit)) {
    const b = button('', 'tornado-row', () => select(row.input.id));
    b.dataset.row = row.input.id;
    b.setAttribute(
      'aria-label',
      `${row.input.label}: decrease input to ${row.lowValue}, result change ${row.low === undefined ? 'undefined' : formatValue({ amount: row.low, unit })}; increase input to ${row.highValue}, result change ${row.high === undefined ? 'undefined' : formatValue({ amount: row.high, unit })}`,
    );
    const name = element('span', 'tornado-name');
    name.append(
      element('strong', '', row.input.label),
      element('span', '', row.input.source ? `@${row.input.source}` : 'assumption'),
    );
    const plot = element('span', 'tornado-plot');
    plot.append(element('span', 'tornado-zero'));
    for (const [value, kind] of [
      [row.low, 'low'],
      [row.high, 'high'],
    ] as const) {
      if (value === undefined || value === 0) continue;
      const bar = element('span', `tornado-bar ${kind}`);
      bar.style.left = `${50 + Math.min(0, (value / maximum) * 48)}%`;
      bar.style.width = `${Math.max((Math.abs(value) / maximum) * 48, 0.35)}%`;
      plot.append(bar);
    }
    const extent = element('span', 'tornado-extent');
    if (row.lowError || row.highError) {
      extent.textContent = 'Undefined';
      extent.classList.add('undefined');
      b.title = [row.lowError, row.highError].filter(Boolean).join(' · ');
    } else if (row.impact === 0) extent.textContent = 'No change';
    else if (
      row.low !== undefined &&
      row.high !== undefined &&
      row.low <= 0 &&
      row.high >= 0 &&
      Math.abs(Math.abs(row.low) - Math.abs(row.high)) <= row.impact * 1e-9
    )
      extent.textContent = `±${formatValue({ amount: row.impact, unit })}`;
    else
      extent.textContent = `${row.low === undefined ? '—' : formatValue({ amount: row.low, unit })} / ${row.high === undefined ? '—' : formatValue({ amount: row.high, unit })}`;
    b.title = b.getAttribute('aria-label') ?? '';
    b.append(name, plot, extent);
    if (withShares) {
      const cell = shareCell(row, shares);
      b.append(cell);
      const described = cell.title || cell.textContent;
      if (described)
        b.setAttribute(
          'aria-label',
          `${b.getAttribute('aria-label')}; share of variance: ${described}`,
        );
    }
    b.addEventListener('pointerenter', () => highlight(row.input.id));
    b.addEventListener('pointerleave', () => highlight(undefined));
    b.addEventListener('focus', () => highlight(row.input.id));
    b.addEventListener('blur', () => highlight(undefined));
    container.append(b);
  }
  if (rows.length > limit)
    container.append(
      button(`Show all ${rows.length} ranked inputs`, 'text-button more-inputs', () => {
        renderSensitivity(container, rows, unit, select, highlight, true, shares);
      }),
    );
  if (focused)
    container.querySelectorAll<HTMLButtonElement>('[data-row]').forEach((node) => {
      if (node.dataset.row === focused) node.focus({ preventScroll: true });
    });
}
