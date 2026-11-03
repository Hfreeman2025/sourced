import { parse } from '../lang/parser';
import { lex } from '../lang/lexer';
import type { Amount, Expr, Span } from '../lang/types';
import type { InputUncertainty } from '../lang/runtime';
import { resolveUncertainty } from '../lang/uncertainty';
export interface InputLiteral {
  id: string;
  label: string;
  value: number;
  unit: string;
  source?: string;
  assumption?: string;
  start: number;
  end: number;
  literal: Span;
  raw: string;
  step: number;
  /** `value` is a data input; `spread` is a number inside an uncertainty
   * clause. Spreads can be dragged, but they are not perturbed as inputs. */
  role: 'value' | 'spread';
  /** For a value: its declared, valid uncertainty. */
  uncertainty?: InputUncertainty;
  /** For a spread: the value input it qualifies. */
  owner?: string;
  /** For a value: the whole `~ … @source` clause, valid or not. */
  clause?: Span;
}
const spreadParts = (expr: Extract<Expr, { kind: 'number' }>): [string, Amount][] => {
  const spread = expr.uncertainty?.spread;
  if (!spread) return [];
  switch (spread.kind) {
    case 'plusminus':
      return [['spread', spread.width]];
    case 'normal':
      return [['sd', spread.sd]];
    case 'lognormal':
      return [['factor', spread.factor]];
    default:
      return [
        ['low', spread.low],
        ['high', spread.high],
      ];
  }
};
const stepFor = (text: string, value: number) => {
  const mantissa = text.split(/[eE]/)[0] ?? '';
  const decimals = mantissa.split('.')[1]?.replaceAll('_', '').length ?? 0;
  return decimals
    ? Math.max(Number.MIN_VALUE, 10 ** -decimals)
    : Math.max(1, 10 ** (Math.floor(Math.log10(Math.abs(value) || 1)) - 2));
};
export function collectInputs(source: string): InputLiteral[] {
  const program = parse(source),
    inputs: InputLiteral[] = [];
  const visit = (
    expr: Expr,
    label: string,
    assumption?: string,
    signed?: { start: number; sign: number },
  ): void => {
    if (expr.kind === 'number') {
      const token = lex(source.slice(expr.start, expr.end), expr.start).tokens.find(
        (t) => t.kind === 'number',
      );
      if (!token) return;
      // A literal written `-5` carries its own sign and starts at the minus.
      const negative = source[expr.start] === '-';
      const start = signed?.start ?? (negative ? expr.start : token.start),
        value = expr.value * (signed?.sign ?? 1);
      const raw = source.slice(start, token.end);
      const ordinal = inputs.filter(
        (input) => input.role === 'value' && input.id.startsWith(`${label}:`),
      ).length;
      const id = `${label}:${ordinal}`,
        name = ordinal ? `${label} [${ordinal + 1}]` : label;
      let uncertainty: InputUncertainty | undefined;
      if (expr.uncertainty)
        try {
          uncertainty = {
            distribution: resolveUncertainty(expr.value, expr.unit, expr.uncertainty),
            ...(expr.uncertainty.source ? { source: expr.uncertainty.source } : {}),
            span: { start: expr.uncertainty.spread.start, end: expr.uncertainty.spread.end },
          };
        } catch {
          // The checker reports the invalid clause; the literal stays draggable.
          uncertainty = undefined;
        }
      inputs.push({
        id,
        label: name,
        value,
        unit: expr.unit,
        source: expr.source,
        assumption,
        start,
        end: token.end,
        literal: { start: expr.start, end: expr.end },
        raw,
        step: stepFor(token.text, value),
        role: 'value',
        ...(uncertainty ? { uncertainty } : {}),
        ...(expr.uncertainty
          ? { clause: { start: expr.uncertainty.start, end: expr.uncertainty.end } }
          : {}),
      });
      for (const [part, amount] of spreadParts(expr)) {
        const number = lex(source.slice(amount.start, amount.end), amount.start).tokens.find(
          (t) => t.kind === 'number',
        );
        if (!number) continue;
        inputs.push({
          id: `${id}:${part}`,
          label: `${name} ${part}`,
          value: amount.value,
          // A bound without a unit is in its quantity's unit.
          unit: amount.unit || (part === 'factor' ? '' : expr.unit),
          source: expr.uncertainty?.source,
          assumption,
          start: amount.start,
          end: number.end,
          literal: { start: amount.start, end: amount.end },
          raw: source.slice(amount.start, number.end),
          step: stepFor(number.text, amount.value),
          role: 'spread',
          owner: id,
        });
      }
    } else if (expr.kind === 'unary') {
      visit(
        expr.value,
        label,
        assumption,
        // Only a sign written directly before the number is part of its text;
        // `-(5 kg)` keeps its parenthesis intact.
        expr.value.kind === 'number' && /^[+-]\s*$/.test(source.slice(expr.start, expr.value.start))
          ? { start: expr.start, sign: expr.op === '-' ? -1 : 1 }
          : undefined,
      );
    } else if (expr.kind === 'binary') {
      visit(expr.left, label, assumption);
      visit(expr.right, label, assumption);
    } else if (expr.kind === 'list')
      expr.items.forEach((item) => {
        visit(item, label, assumption);
      });
    else if (expr.kind === 'convert') visit(expr.value, label, assumption);
    else if (expr.kind === 'call')
      expr.args.forEach((arg, i) => {
        if (!(expr.name === 'round' && i === 1)) visit(arg, label, assumption);
      });
  };
  program.statements.forEach((statement, i) => {
    if (statement.kind === 'binding')
      visit(statement.value, statement.name, statement.assume ? statement.name : undefined);
    if (statement.kind === 'function') visit(statement.body, `${statement.name} literal`);
    if (statement.kind === 'print')
      statement.parts.forEach((part) => {
        if ('expr' in part) visit(part.expr, `print ${i + 1}`);
      });
  });
  return inputs;
}
export function replaceInput(source: string, input: InputLiteral, value: number): string {
  if (!Number.isFinite(value)) throw new Error('A scrubbed value must be finite.');
  let text = value.toString();
  if (input.raw.includes('_') && !/[eE]/.test(text)) {
    const [integer = '', fraction] = text.split('.');
    text = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '_') + (fraction ? `.${fraction}` : '');
  }
  return source.slice(0, input.start) + text + source.slice(input.end);
}
/** A deterministic what-if for one value: replaces it and drops that
 * literal's own spread, which describes the original value, not the probe. */
export function probeInput(source: string, input: InputLiteral, value: number): string {
  const replaced = replaceInput(source, input, value);
  if (!input.clause) return replaced;
  const shift = replaced.length - source.length;
  let start = input.clause.start + shift;
  while (start > 0 && /[ \t]/.test(replaced[start - 1] ?? '')) start--;
  return replaced.slice(0, start) + replaced.slice(input.clause.end + shift);
}
export function scrubValue(
  input: InputLiteral,
  pixels: number,
  fine = false,
  coarse = false,
): number {
  const step = input.step * (fine ? 0.01 : coarse ? 10 : 1);
  const value = input.value + Math.round(pixels) * step;
  const places = Math.max(0, -Math.floor(Math.log10(step)));
  return places <= 100 ? Number(value.toFixed(places)) : value;
}
