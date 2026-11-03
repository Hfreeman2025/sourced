import type { OutputDistribution } from '../analysis/montecarlo';
import { formatValue } from '../lang/runtime';
import { button, element } from './dom';

const ns = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Enough decimals to give the 90% interval three significant figures. */
export function decimalsFor(width: number): number {
  if (!(width > 0) || !Number.isFinite(width)) return 2;
  return Math.min(6, Math.max(0, 2 - Math.floor(Math.log10(width))));
}

export function formatAt(amount: number, unit: string, decimals: number): string {
  const magnitude = Math.abs(amount);
  if (magnitude > 0 && (magnitude < 1e-6 || magnitude >= 1e12))
    return formatValue({ amount, unit });
  const text = new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: unit === '£' ? Math.max(2, decimals) : decimals,
    maximumFractionDigits: unit === '£' ? Math.max(2, decimals) : decimals,
  }).format(Math.abs(amount));
  const sign = amount < 0 && Number(text.replaceAll(',', '')) !== 0 ? '-' : '';
  if (unit === '£') return `${sign}£${text}`;
  return `${sign}${text}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
}

export interface DistributionState {
  label: string;
  distribution: OutputDistribution | null | undefined;
  refined: boolean;
  runs: number;
  seed: number;
  /** Waiting for this program's first sampled pass. */
  pending: boolean;
  /** The drawing belongs to the previous version of the code. */
  stale?: boolean;
  suggestion?: { text: string; apply: () => void };
  reseed?: () => void;
}

const HEIGHT = 118,
  TOP = 22,
  BASE = 72,
  DIMENSION = 89,
  LABELS = 109;

function drawing(width: number, d: OutputDistribution, label: string): SVGSVGElement {
  const summary = d.summary,
    bins = d.histogram;
  const plot = svg('svg', {
    class: 'distribution-plot',
    viewBox: `0 0 ${width} ${HEIGHT}`,
    width,
    height: HEIGHT,
    role: 'img',
  });
  if (!summary || !bins) return plot;
  const decimals = decimalsFor(summary.p95 - summary.p5);
  const at = (value: number) => formatAt(value, d.unit, decimals);
  plot.setAttribute(
    'aria-label',
    `Distribution of ${label} from ${summary.count.toLocaleString('en-GB')} runs: 5th percentile ${at(summary.p5)}, median ${at(summary.p50)}, 95th percentile ${at(summary.p95)}. Central inputs give ${formatValue({ amount: d.central, unit: d.unit })}.`,
  );
  const left = 8,
    right = width - 8;
  const span = bins.high - bins.low || 1;
  const x = (value: number) => left + ((value - bins.low) / span) * (right - left);
  const peak = Math.max(1, ...bins.counts);
  const step = (right - left) / bins.counts.length;
  let outline = `M${left},${BASE}`;
  bins.counts.forEach((count, i) => {
    const y = BASE - (count / peak) * (BASE - TOP);
    outline += ` V${y.toFixed(2)} H${(left + (i + 1) * step).toFixed(2)}`;
  });
  outline += ` V${BASE} Z`;
  const defs = svg('defs', {});
  for (const [id, colour] of [
    ['hatch-band', 'var(--blue)'],
    ['hatch-tail', '#b7bec5'],
  ] as const) {
    const pattern = svg('pattern', {
      id,
      patternUnits: 'userSpaceOnUse',
      width: 4,
      height: 4,
      patternTransform: 'rotate(45)',
    });
    // CSS variables only resolve in style, not in presentation attributes.
    const hatch = svg('line', { x1: 0, y1: 0, x2: 0, y2: 4, 'stroke-width': 1.1 });
    hatch.style.stroke = colour;
    pattern.append(hatch);
    defs.append(pattern);
  }
  const p5 = x(summary.p5),
    p50 = x(summary.p50),
    p95 = x(summary.p95);
  const clip = svg('clipPath', { id: 'band-clip' });
  clip.append(svg('rect', { x: p5, y: 0, width: Math.max(0, p95 - p5), height: HEIGHT }));
  defs.append(clip);
  plot.append(
    defs,
    svg('path', { d: outline, fill: 'url(#hatch-tail)', class: 'distribution-tail' }),
    svg('path', { d: outline, fill: 'url(#hatch-band)', 'clip-path': 'url(#band-clip)' }),
    svg('path', { d: outline, class: 'distribution-outline' }),
    svg('line', { x1: left - 4, x2: right + 4, y1: BASE, y2: BASE, class: 'distribution-base' }),
  );
  // Extension lines and a chain dimension: P5 to median to P95.
  for (const position of [p5, p50, p95])
    plot.append(
      svg('line', { x1: position, x2: position, y1: BASE + 3, y2: DIMENSION + 6, class: 'dimension-extension' }),
    );
  plot.append(svg('line', { x1: p5, x2: p95, y1: DIMENSION, y2: DIMENSION, class: 'dimension-line' }));
  if (p95 - p5 > 18)
    for (const [tip, sign] of [
      [p5, 1],
      [p95, -1],
    ] as const)
      plot.append(
        svg('path', {
          d: `M${tip},${DIMENSION} l${7 * sign},-2.4 v4.8 Z`,
          class: 'dimension-arrow',
        }),
      );
  plot.append(
    svg('line', {
      x1: p50 - 3,
      x2: p50 + 3,
      y1: DIMENSION + 3,
      y2: DIMENSION - 3,
      class: 'dimension-tick',
    }),
    // The median is a centre line, in drawing convention.
    svg('line', { x1: p50, x2: p50, y1: TOP - 4, y2: BASE, class: 'distribution-median' }),
  );
  // Percentile values under the dimension, nudged apart if they would touch.
  // £ and % stay attached to every value; other units appear once, at the end.
  const inline = d.unit === '£' || d.unit === '%';
  const number = (value: number) => formatAt(value, inline ? d.unit : '', decimals);
  const texts = [
    { text: `P5 ${number(summary.p5)}`, x: p5 },
    { text: `P50 ${number(summary.p50)}`, x: p50 },
    { text: `P95 ${number(summary.p95)}${!inline && d.unit ? ` ${d.unit}` : ''}`, x: p95 },
  ].map((item) => ({ ...item, width: item.text.length * 6.9 }));
  const placed = texts.map((item) => ({
    ...item,
    left: Math.min(Math.max(left, item.x - item.width / 2), right - item.width),
  }));
  for (let i = 1; i < placed.length; i++) {
    const previous = placed[i - 1],
      current = placed[i];
    if (!previous || !current) continue;
    const overlap = previous.left + previous.width + 10 - current.left;
    if (overlap > 0) current.left = Math.min(right - current.width, current.left + overlap);
  }
  for (let i = placed.length - 2; i >= 0; i--) {
    const current = placed[i],
      next = placed[i + 1];
    if (!current || !next) continue;
    const overlap = current.left + current.width + 10 - next.left;
    if (overlap > 0) current.left = Math.max(left, current.left - overlap);
  }
  for (const item of placed)
    plot.append(
      svg('text', { x: item.left, y: LABELS, class: 'distribution-value' }, item.text),
    );
  // The printed answer: a datum line at the central-input value.
  const central = x(d.central);
  const caption = `central inputs ${formatValue({ amount: d.central, unit: d.unit })}`;
  const captionWidth = caption.length * 6.4;
  const after = central + 6 + captionWidth <= right;
  plot.append(
    svg('line', { x1: central, x2: central, y1: 15, y2: BASE, class: 'distribution-central' }),
    svg(
      'text',
      {
        x: after ? central + 6 : Math.max(left, central - 6 - captionWidth),
        y: 13,
        class: 'distribution-caption',
      },
      caption,
    ),
  );
  return plot;
}

export function renderDistribution(container: HTMLElement, state: DistributionState) {
  const d = state.distribution;
  container.replaceChildren();
  container.classList.toggle('is-preview', !state.refined);
  container.classList.remove('is-exact', 'is-pending', 'is-empty');
  if (state.pending && !d) {
    container.classList.add('is-pending');
    container.append(element('p', 'distribution-status', 'Sampling the declared uncertainties…'));
    return;
  }
  if (!d) {
    container.classList.add('is-empty');
    return;
  }
  if (d.exact) {
    container.classList.add('is-exact');
    const note = element('p', 'distribution-status');
    note.append(
      element('strong', '', 'Exact. '),
      document.createTextNode(
        'No input behind this result declares an uncertainty, so every run gives the same answer.',
      ),
    );
    container.append(note);
    if (state.suggestion) {
      const suggestion = state.suggestion;
      const action = button('', 'text-button suggestion-button', suggestion.apply);
      action.append('Try ', element('code', '', suggestion.text));
      container.append(action);
    }
    return;
  }
  const summary = d.summary;
  if (!summary) {
    container.classList.add('is-exact');
    container.append(
      element(
        'p',
        'distribution-status has-error',
        'Every sampled run failed: a division by zero, a negative square root or an overflow.',
      ),
    );
    return;
  }
  const style = getComputedStyle(container);
  const inner =
    container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const width = Math.max(240, Math.floor(inner > 0 ? inner : 520));
  container.append(drawing(width, d, state.label));
  const meta = element('p', 'distribution-meta');
  const runs = summary.count + d.undefinedRuns;
  meta.append(
    element(
      'span',
      state.stale ? 'stale-note' : '',
      state.stale
        ? 'Previous code · sampling the edit…'
        : state.refined
          ? `${runs.toLocaleString('en-GB')} runs · seed ${state.seed}`
          : `Preview · ${runs.toLocaleString('en-GB')} runs while you adjust`,
    ),
  );
  const beyond = (d.histogram?.below ?? 0) + (d.histogram?.above ?? 0);
  if (beyond)
    meta.append(
      element(
        'span',
        '',
        `${((beyond / summary.count) * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}% of runs beyond the drawing`,
      ),
    );
  meta.append(element('span', '', 'inputs sampled independently'));
  if (d.undefinedRuns)
    meta.append(
      element(
        'span',
        'has-error',
        `${d.undefinedRuns.toLocaleString('en-GB')} runs undefined and excluded`,
      ),
    );
  if (state.reseed && state.refined) meta.append(button('Reseed', 'text-button reseed', state.reseed));
  container.append(meta);
}


/** The interval under the printed answer: the number and how sure it is. */
export function intervalLine(d: OutputDistribution | null | undefined): HTMLElement | undefined {
  const summary = d?.summary;
  if (!d || !summary) return undefined;
  const decimals = decimalsFor(summary.p95 - summary.p5);
  const at = (value: number) => formatAt(value, d.unit, decimals);
  // As in prose: £ and % on both ends, any other unit once at the end.
  const inline = d.unit === '£' || d.unit === '%';
  const line = element('p', 'interval-line');
  line.title = `90% of the ${(summary.count + d.undefinedRuns).toLocaleString('en-GB')} runs fall between the 5th and 95th percentiles.`;
  line.append(
    document.createTextNode('90% between '),
    element('strong', '', inline ? at(summary.p5) : formatAt(summary.p5, '', decimals)),
    document.createTextNode(' and '),
    element('strong', '', at(summary.p95)),
  );
  const shift = summary.mean - d.central;
  line.append(
    element(
      'span',
      'interval-note',
      `mean ${at(summary.mean)}${
        Math.abs(shift) >= 10 ** -decimals / 2
          ? `, ${shift > 0 ? 'above' : 'below'} the central answer`
          : ''
      }`,
    ),
  );
  return line;
}
