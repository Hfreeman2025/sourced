import type { RunResult } from '../lang';
import { formatNumber, formatValue, type LineageNode } from '../lang/runtime';
import { reachableNodes } from './sensitivity';
export interface DiagramNode {
  node: LineageNode;
  x: number;
  y: number;
  level: number;
  label: string;
  width: number;
  lines: { text: string; kind: 'number' | 'unit' | 'label' | 'value'; y: number }[];
}
export interface DiagramEdge {
  from: string;
  to: string;
}
export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
  root?: string;
  vertical?: boolean;
  large?: boolean;
}
export function diagramLayout(result: RunResult, index: number, availableWidth = 650): Diagram {
  const map = new Map(result.nodes.map((n) => [n.id, n])),
    rootId = result.outputs[index]?.value?.node;
  if (!rootId) return { nodes: [], edges: [], width: 650, height: 220 };
  const canonical = new Map<string, string>();
  const unwrap = (id: string): string => {
    const path: string[] = [];
    let current = id;
    while (!canonical.has(current)) {
      const node = map.get(current),
        child = node?.children.length === 1 ? map.get(node.children[0] ?? '') : undefined;
      const transparent =
        node?.kind === 'binding' ||
        (node?.kind === 'assumption' &&
          child &&
          node.dependencies.every((d) => child.dependencies.includes(d)));
      if (!child || !transparent) break;
      path.push(current);
      current = child.id;
    }
    current = canonical.get(current) ?? current;
    path.forEach((key) => {
      canonical.set(key, current);
    });
    return current;
  };
  const root = unwrap(rootId),
    reachable = reachableNodes(result, index),
    nodes = new Map<string, DiagramNode>(),
    edges: DiagramEdge[] = [];
  let leaf = 0;
  // Evaluation emits a topological order. Iteration also handles very long chains
  // without blowing the browser stack or silently dropping derivation steps.
  for (const node of result.nodes) {
    if (!reachable.has(node.id) || unwrap(node.id) !== node.id) continue;
    const children = node.children
      .map((id) => nodes.get(unwrap(id)))
      .filter((n): n is DiagramNode => n !== undefined);
    const level = children.length ? Math.max(...children.map((n) => n.level)) + 1 : 0;
    const y = children.length
      ? children.reduce((sum, n) => sum + n.y, 0) / children.length
      : 42 + leaf++ * 74;
    const label = node.kind === 'source' ? (node.source?.name ?? node.label) : node.label;
    const short = label.length > 24 ? `${label.slice(0, 22)}…` : label;
    const lines: DiagramNode['lines'] = !node.children.length
      ? [
          { text: formatNumber(node.amount), kind: 'number', y: -12 },
          { text: node.unit || 'dimensionless', kind: 'unit', y: 8 },
          { text: node.source ? `@${short}` : `assume ${short}`, kind: 'label', y: 28 },
        ]
      : [
          { text: label.startsWith('round') ? 'round' : short, kind: 'label', y: -7 },
          { text: formatValue(node), kind: 'value', y: 14 },
        ];
    // Conservative text bounds keep annotations in their own column. The browser
    // regression also measures the actual glyph bounds at every zoom step.
    // An uncertain terminal draws its input's shape after the number.
    const glyph = !node.children.length && node.uncertainty ? 36 : 0;
    const width =
      24 + Math.max(...lines.map((line, i) => line.text.length * 8.5 + (i === 0 ? glyph : 0)));
    nodes.set(node.id, { node, x: 0, y, level, label, width, lines });
    children.forEach((child) => {
      edges.push({ from: child.node.id, to: node.id });
    });
  }
  const maxLevel = Math.max(1, ...[...nodes.values()].map((n) => n.level));
  const columns = new Map<number, DiagramNode[]>();
  nodes.forEach((node) => {
    const column = columns.get(node.level) ?? [];
    column.push(node);
    columns.set(node.level, column);
  });
  columns.forEach((column) => {
    column.sort((a, b) => a.y - b.y);
    let previous = -32;
    for (const item of column) {
      item.y = Math.max(item.y, previous + 74);
      previous = item.y;
    }
  });
  const ordered = [...columns.entries()].sort(([a], [b]) => a - b);
  const columnWidths = ordered.map(([, column]) => Math.max(...column.map((node) => node.width)));
  const naturalWidth =
    columnWidths.reduce((sum, width) => sum + width, 48) + (ordered.length - 1) * 32;
  const width = Math.max(availableWidth, ...[...nodes.values()].map((node) => node.width + 48));
  const vertical = naturalWidth > width || maxLevel >= 5;
  const large = nodes.size > 12 || maxLevel >= 7 || leaf > 8 || width > availableWidth;
  if (vertical) {
    const operations = [...nodes.values()].filter((node) => node.level > 0);
    const spine = (width - Math.max(...operations.map((node) => node.width), 0)) / 2;
    let top = 42;
    for (const [level, column] of ordered) {
      const rows: DiagramNode[][] = [[]];
      let used = 0;
      for (const node of column) {
        if (used && used + 24 + node.width > width - 48) {
          rows.push([]);
          used = 0;
        }
        rows[rows.length - 1]?.push(node);
        used += (used ? 24 : 0) + node.width;
      }
      for (const row of rows) {
        const total = row.reduce((sum, node) => sum + node.width, 0);
        const gap = row.length > 1 ? (width - 48 - total) / (row.length - 1) : 0;
        let x = row.length === 1 ? (level ? spine : (width - total) / 2) : 24;
        for (const node of row) {
          node.x = x;
          node.y = top;
          x += node.width + gap;
        }
        top += 78;
      }
    }
  } else {
    const gap =
      (width - 48 - columnWidths.reduce((sum, value) => sum + value, 0)) /
      Math.max(1, ordered.length - 1);
    let x = 24;
    ordered.forEach(([, column], i) => {
      column.forEach((node) => {
        node.x = x;
      });
      x += (columnWidths[i] ?? 0) + gap;
    });
  }
  return {
    nodes: [...nodes.values()],
    edges,
    width,
    height: Math.max(...[...nodes.values()].map((n) => n.y + 48)),
    root,
    vertical,
    large,
  };
}
