import { combineUnits, compatible, getUnit, powerUnit, rational, type Unit } from './units';
import { fail, type Span, type Statement, type Uncertainty } from './types';
import { resolveUncertainty } from './uncertainty';
import type { Distribution } from '../stats/distributions';
export type Source = Extract<Statement, { kind: 'source' }>;
/** A literal's declared uncertainty, resolved in its own unit. `source` is
 * the citation; when it is absent the spread is an explicit assumption. */
export interface InputUncertainty {
  distribution: Distribution;
  source?: string;
  span: Span;
}
export interface LineageNode {
  id: string;
  kind: 'source' | 'assumption' | 'operation' | 'binding' | 'conversion';
  label: string;
  amount: number;
  unit: string;
  children: string[];
  dependencies: string[];
  span: Span;
  source?: Source;
  uncertainty?: InputUncertainty;
}
export interface Value {
  amount: number;
  unit: Unit;
  node: string;
  dependencies: string[];
}
export type Datum = Value | Datum[];
export interface Output {
  label: string;
  text: string;
  value?: Value;
  span: Span;
}
export interface Evaluation {
  outputs: Output[];
  nodes: LineageNode[];
  bindings: Record<string, Datum>;
}
const numberFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 });
const currencyFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
export function formatNumber(amount: number): string {
  const magnitude = Math.abs(amount);
  if (magnitude > 0 && (magnitude < 1e-6 || magnitude >= 1e12))
    return amount.toExponential(5).replace(/\.?0+e/, 'e');
  return numberFormatter.format(Object.is(amount, -0) ? 0 : amount);
}
export function formatValue(value: { amount: number; unit: Unit | string }): string {
  const unit = typeof value.unit === 'string' ? value.unit : value.unit.symbol;
  if (
    unit === '£' &&
    Math.abs(value.amount) > 0 &&
    (Math.abs(value.amount) < 1e-6 || Math.abs(value.amount) >= 1e12)
  )
    return `${value.amount < 0 ? '-' : ''}£${formatNumber(Math.abs(value.amount))}`;
  return unit === '£'
    ? currencyFormatter.format(value.amount)
    : `${formatNumber(value.amount)}${unit ? (unit === '%' ? '' : ' ') + unit : ''}`;
}
const shift = (amount: number, places: number): number => {
  const [base, exponent = '0'] = amount.toString().split('e');
  return Number(`${base}e${Number(exponent) + places}`);
};
/** Decimal rounding of the shortest representation; ties go toward +∞, as
 * Math.round does. Shared by the interpreter and the column evaluator. */
export function roundAmount(amount: number, places: number): number {
  return Math.abs(amount) >= 1e21 ? amount : shift(Math.round(shift(amount, places)), -places);
}
export function createRuntime() {
  const nodes: LineageNode[] = [],
    outputs: Output[] = [];
  const sources = new Map<string, Source>();
  const bindings: Record<string, Datum> = Object.create(null);
  const scalar = (value: Datum, span: Span): Value =>
    Array.isArray(value)
      ? fail(
          span,
          'Expected a quantity',
          'A list cannot be used as a single number.',
          'Use sum(list).',
        )
      : value;
  const node = (
    amount: number,
    unit: Unit,
    kind: LineageNode['kind'],
    label: string,
    children: Value[],
    span: Span,
    dependency?: string,
    source?: Source,
    uncertainty?: InputUncertainty,
  ): Value => {
    if (!Number.isFinite(amount))
      fail(
        span,
        'Non-finite result',
        'This calculation produced a value outside the finite range.',
        'Check the inputs and avoid division by zero.',
      );
    if (nodes.length >= 10000)
      fail(
        span,
        'Calculation too large',
        'This program generated more than 10,000 calculation steps.',
        'Use fewer repeated calls or smaller lists.',
      );
    const dependencies = [
      ...new Set([
        ...children.flatMap((child) => child.dependencies),
        ...(dependency ? [dependency] : []),
      ]),
    ].sort();
    const id = `n${nodes.length}`;
    nodes.push({
      id,
      amount,
      unit: unit.symbol,
      kind,
      label,
      children: children.map((child) => child.node),
      dependencies,
      source,
      ...(uncertainty ? { uncertainty } : {}),
      span: { start: span.start, end: span.end },
    });
    return { amount, unit, node: id, dependencies };
  };
  const rt = {
    source(source: Source) {
      sources.set(source.name, source);
    },
    number(
      amount: number,
      symbol: string,
      sourceName: string | undefined,
      assumption: string | undefined,
      span: Span,
      uncertainty?: Uncertainty,
    ): Value {
      const source = sourceName ? sources.get(sourceName) : undefined;
      const declared = uncertainty
        ? {
            distribution: resolveUncertainty(amount, symbol, uncertainty),
            ...(uncertainty.source ? { source: uncertainty.source } : {}),
            span: { start: uncertainty.spread.start, end: uncertainty.spread.end },
          }
        : undefined;
      return node(
        amount,
        getUnit(symbol, span),
        source ? 'source' : 'assumption',
        source ? `@${source.name}` : (assumption ?? 'precision'),
        [],
        span,
        source ? `source:${source.name}` : assumption ? `assumption:${assumption}` : undefined,
        source,
        declared,
      );
    },
    bind(name: string, value: Datum, assumption: boolean, span: Span): Datum {
      const wrap = (v: Datum): Datum =>
        Array.isArray(v)
          ? v.map(wrap)
          : node(
              v.amount,
              v.unit,
              assumption ? 'assumption' : 'binding',
              name,
              [v],
              span,
              assumption ? `assumption:${name}` : undefined,
            );
      const result = wrap(value);
      bindings[name] = result;
      return result;
    },
    unary(op: string, datum: Datum, span: Span): Value {
      const value = scalar(datum, span);
      return node(
        op === '-' ? -value.amount : value.amount,
        value.unit,
        'operation',
        op === '-' ? 'negate' : 'positive',
        [value],
        span,
      );
    },
    binary(op: string, left: Datum, right: Datum, span: Span): Value {
      const a = scalar(left, span),
        b = scalar(right, span);
      let amount: number;
      let unit: Unit;
      if (op === '+' || op === '-') {
        compatible(a.unit, b.unit, span);
        const converted = (b.amount * b.unit.scale) / a.unit.scale;
        amount = op === '+' ? a.amount + converted : a.amount - converted;
        unit = a.unit;
      } else {
        if (op === '/' && b.amount === 0)
          fail(
            span,
            'Division by zero',
            'A calculation cannot divide by zero.',
            'Change the denominator to a non-zero quantity.',
          );
        amount = op === '*' ? a.amount * b.amount : a.amount / b.amount;
        unit = combineUnits(a.unit, b.unit, op === '*' ? '*' : '/');
      }
      return node(
        amount,
        unit,
        'operation',
        { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide' }[op] ?? op,
        [a, b],
        span,
      );
    },
    convert(datum: Datum, symbol: string, span: Span): Value {
      const value = scalar(datum, span),
        target = getUnit(symbol, span);
      compatible(value.unit, target, span, 'converting');
      return node(
        (value.amount * value.unit.scale) / target.scale,
        target,
        'conversion',
        `convert to ${symbol}`,
        [value],
        span,
      );
    },
    builtin(name: string, args: Datum[], span: Span): Value {
      if (name === 'sum') {
        const list = args[0];
        if (!Array.isArray(list) || !list.length)
          return fail(
            span,
            'sum needs a list',
            'Expected a non-empty list.',
            'Use sum([first, second]).',
          );
        const values = list.map((v) => scalar(v, span));
        const first = values[0];
        if (!first)
          return fail(span, 'Empty list', 'There are no values to sum.', 'Add at least one value.');
        let amount = 0;
        for (const value of values) {
          compatible(first.unit, value.unit, span);
          amount += (value.amount * value.unit.scale) / first.unit.scale;
        }
        return node(amount, first.unit, 'operation', 'sum', values, span);
      }
      const first = args[0];
      if (!first)
        return fail(span, 'Missing argument', `${name} needs a quantity.`, `Use ${name}(value).`);
      const value = scalar(first, span);
      if (name === 'sqrt') {
        if (value.amount < 0)
          fail(
            span,
            'No real square root',
            'A negative quantity has no real square root.',
            'Use a non-negative quantity.',
          );
        return node(
          Math.sqrt(value.amount),
          powerUnit(value.unit, rational(1, 2)),
          'operation',
          'square root',
          [value],
          span,
        );
      }
      const precision = args[1];
      if (!precision)
        return fail(span, 'Missing precision', 'round needs a precision.', 'Use round(value, 2).');
      const places = scalar(precision, span).amount;
      const rounded = roundAmount(value.amount, places);
      return node(
        rounded,
        value.unit,
        'operation',
        `round to ${places} decimal places`,
        [value],
        span,
      );
    },
    print(parts: (string | Datum)[], span: Span) {
      const text = parts
        .map((part) => (typeof part === 'string' ? part : formatValue(scalar(part, span))))
        .join('');
      let prefix = '';
      for (const part of parts) {
        if (typeof part === 'string') prefix += part;
        else {
          const value = scalar(part, span);
          outputs.push({
            label: prefix.trim().replace(/[:=]\s*$/, '') || 'Result',
            text,
            value,
            span: { start: span.start, end: span.end },
          });
          prefix = '';
        }
      }
      if (parts.every((part) => typeof part === 'string'))
        outputs.push({ label: text, text, span: { start: span.start, end: span.end } });
    },
    result(): Evaluation {
      return { outputs, nodes, bindings };
    },
  };
  return rt;
}
export type Runtime = ReturnType<typeof createRuntime>;
