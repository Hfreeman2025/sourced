import { formatValue, type LineageNode } from '../lang/runtime';
import type { RunResult } from '../lang';
import { diagramLayout } from '../analysis/diagram';
import { shapeName, silhouette } from '../stats/distributions';
import { button, element } from './dom';
const ns = 'http://www.w3.org/2000/svg';
const fitObservers = new WeakMap<HTMLElement, () => void>();
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
  text?: string,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}
export function renderLineage(
  container: HTMLElement,
  result: RunResult,
  index: number,
  reveal: (node: LineageNode) => void,
  code = '',
) {
  fitObservers.get(container)?.();
  fitObservers.delete(container);
  container.replaceChildren();
  // The inactive phone tab has no width; its grid still supplies the column's
  // width. Leave one pixel beyond the viewport padding for fractional rounding.
  const panelWidth = () => Math.max(240,
    (container.clientWidth || (container.closest('.analysis-grid')?.clientWidth ?? 0) - 2) - 13);
  const availableWidth = panelWidth();
  const layout = diagramLayout(result, index, availableWidth);
  if (!layout.nodes.length) {
    container.append(
      element(
        'p',
        'panel-empty',
        result.diagnostics.length
          ? 'No derivation is shown while the calculation has errors.'
          : 'A quantity printed by your program will have a derivation here.',
      ),
    );
    return;
  }
  const direction = container.closest('section')?.querySelector('.diagram-direction');
  if (direction)
    direction.textContent = layout.vertical ? 'Inputs ↓ result' : 'Inputs → result';
  const viewport = element('div', 'diagram-viewport');
  viewport.tabIndex = 0;
  viewport.dataset.large = String(Boolean(layout.large));
  viewport.style.height = `${layout.large
    ? Math.min(Math.ceil(layout.height) + 17, innerWidth <= 760 ? 360 : 420)
    : Math.ceil(layout.height) + 17}px`;
  viewport.setAttribute(
    'aria-label',
    'Derivation drawing. Zoom to enlarge, then scroll to pan; select a terminal to inspect its source.',
  );
  const drawing = svg('svg', {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    class: 'technical-diagram',
    role: 'group',
    'aria-label': 'Calculation lineage, from input terminals to the result',
  });
  // Keep SVG text layout at native scale. Resizing the SVG viewport makes
  // Firefox round glyph bounds independently of the annotation's line spacing.
  // Scale the complete drawing instead, so text and geometry stay together.
  drawing.style.width = `${layout.width}px`;
  drawing.style.height = `${layout.height}px`;
  drawing.style.minWidth = '0';
  drawing.style.minHeight = '0';
  drawing.style.position = 'absolute';
  drawing.style.transformOrigin = '0 0';
  const byId = new Map(layout.nodes.map((n) => [n.node.id, n]));
  layout.edges.forEach((edge) => {
    const a = byId.get(edge.from),
      b = byId.get(edge.to);
    if (!a || !b) return;
    const mid = (a.x + a.width + b.x) / 2;
    drawing.append(
      svg('path', {
        d: layout.vertical
          ? `M${a.x},${a.y + 8} V${(a.y + b.y) / 2} H${b.x} V${b.y - 12}`
          : `M${a.x + 8},${a.y} H${mid} V${b.y} H${b.x - 12}`,
        class: 'diagram-wire',
        'data-from': a.node.id,
        'data-to': b.node.id,
      }),
    );
  });
  const detail = element('div', 'diagram-detail');
  detail.append(
    element(
      'p',
      '',
      'Select a terminal to inspect the source. Select an operation to find its code.',
    ),
  );
  const inspect = (node: LineageNode) => {
    drawing.querySelectorAll('.diagram-node').forEach((n) => {
      n.classList.toggle('inspected', n.getAttribute('data-node') === node.id);
    });
    detail.replaceChildren();
    const title = node.source?.title ?? node.label;
    const line = element('div', 'diagram-detail-line');
    line.append(
      element('strong', '', title),
      button('Find in code', 'text-button', () => reveal(node)),
    );
    detail.append(line);
    const metadata = [
      formatValue(node),
      node.source?.page ? `page ${node.source.page}` : '',
      node.source?.year ? `published ${node.source.year}` : '',
      node.kind === 'assumption' ? 'explicit assumption' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    detail.append(element('p', '', metadata));
    if (node.uncertainty) {
      const written = code.slice(node.uncertainty.span.start, node.uncertainty.span.end);
      detail.append(
        element(
          'p',
          'diagram-spread',
          `Spread ~ ${written || shapeName(node.uncertainty.distribution)} · ${shapeName(node.uncertainty.distribution)} · ${node.uncertainty.source ? `cited @${node.uncertainty.source}` : 'assumed'}`,
        ),
      );
    }
    if (node.source?.url) {
      const link = element('a', 'source-link', 'Published reference');
      link.href = node.source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      detail.append(link);
    }
  };
  for (const positioned of layout.nodes) {
    const { node, x, y } = positioned;
    const leaf = !node.children.length;
    const group = svg('g', {
      class: `diagram-node ${leaf ? 'terminal' : 'operation'} ${node.kind}`,
      transform: `translate(${x} ${y})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${node.label}: ${formatValue(node)}`,
      'data-node': node.id,
    });
    group.append(
      svg('rect', {
        x: '-14',
        y: '-28',
        width: String(positioned.width + 14),
        height: '70',
        fill: 'transparent',
        class: 'diagram-hit',
        'pointer-events': 'all',
      }),
    );
    if (leaf) {
      group.append(
        svg('circle', { r: '5', class: 'terminal-point' }),
        svg('line', { x1: '-11', x2: '11', y1: '0', y2: '0', class: 'terminal-cross' }),
      );
    } else {
      group.append(svg('circle', { r: '12', class: 'operation-circle' }));
      const symbol: Record<string, string> = {
        multiply: '×',
        divide: '÷',
        add: '+',
        subtract: '−',
        sum: 'Σ',
        'square root': '√',
        negate: '−',
      };
      group.append(
        svg(
          'text',
          { class: 'operation-symbol', 'text-anchor': 'middle', dy: '4' },
          symbol[node.label] ?? (node.kind === 'conversion' ? '=' : '≈'),
        ),
      );
    }
    // A white annotation field lifts the text off connecting wires. Every node
    // uses the same alignment, including the final operation.
    group.append(
      svg('rect', { x: '14', y: '-28', width: String(positioned.width - 14),
        height: leaf ? '68' : '50', class: 'diagram-annotation' }),
    );
    if (leaf) group.append(svg('line', {
      x1: '12', x2: '12', y1: '-24', y2: '33', class: 'terminal-bracket',
    }));
    if (leaf && node.uncertainty) {
      // The input's own distribution, in miniature: it carries the shape.
      const heights = silhouette(node.uncertainty.distribution, 24);
      const left = 20 + (positioned.lines[0]?.text.length ?? 0) * 8.5 + 8;
      const path = heights
        .map((h, i) => `${i ? 'L' : 'M'}${(left + i).toFixed(1)},${(-11 - h * 11).toFixed(1)}`)
        .join(' ');
      const provenance = node.uncertainty.source ? 'cited' : 'assumed';
      group.append(
        svg('path', { d: `${path} V-11 H${left} Z`, class: `terminal-spread ${provenance}` }),
        svg('line', {
          x1: String(left - 1),
          x2: String(left + 24),
          y1: '-11',
          y2: '-11',
          class: `terminal-spread-base ${provenance}`,
        }),
      );
    }
    positioned.lines.forEach((line) => { group.append(
      svg(
        'text',
        {
          class: `diagram-${line.kind}`,
          x: '20',
          y: String(line.y),
        },
        line.text,
      ),
    ); });
    group.addEventListener('click', () => inspect(node));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        inspect(node);
      }
    });
    drawing.append(group);
  }
  const sheet = element('div', 'diagram-sheet');
  sheet.append(drawing);
  viewport.append(sheet);
  const footer = element('div', 'diagram-footer');
  if (layout.large) container.append(element('p', 'diagram-scroll-hint',
    'Large derivation: scroll to follow the calculation. Zoom to inspect detail.'));
  container.append(viewport, footer);
  const controls = element('div', 'diagram-controls');
  let zoom = 1;
  let fitted = true;
  const minimumZoom = 11 / 12;
  const scale = () => {
    sheet.style.width = `${layout.width * zoom}px`;
    sheet.style.height = `${layout.height * zoom}px`;
    drawing.style.transform = `scale(${zoom})`;
  };
  const fitZoom = () => {
    const style = getComputedStyle(viewport);
    const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    // The phone's inactive tab has no dimensions. Its observer fits the drawing
    // as soon as the panel is revealed, before the first presented frame.
    if (width <= 0 || viewport.clientHeight <= 0) return undefined;
    return Math.max(minimumZoom, Math.min(1, (width - 1) / layout.width));
  };
  const fit = () => {
    if (viewport.clientHeight > 0 && Math.abs(panelWidth() - availableWidth) > 1) {
      renderLineage(container, result, index, reveal, code);
      return;
    }
    zoom = fitZoom() ?? zoom;
    scale();
  };
  scale();
  controls.append(
    button('−', 'diagram-zoom', () => {
      fitted = false;
      zoom = Math.max(minimumZoom, zoom - 0.25);
      scale();
    }),
    button('+', 'diagram-zoom', () => {
      fitted = false;
      zoom = Math.min(2, zoom + 0.25);
      scale();
    }),
    button('Fit', 'text-button', () => {
      fitted = true;
      fit();
    }),
  );
  controls.lastElementChild?.setAttribute('title', 'Fit at readable size; text stays at least 11px.');
  footer.append(detail, controls);
  let resizeFrame = 0;
  const observer = new ResizeObserver(() => {
    if (!fitted || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (fitted) fit();
    });
  });
  observer.observe(viewport);
  fitObservers.set(container, () => {
    observer.disconnect();
    cancelAnimationFrame(resizeFrame);
  });
  fit();
}
