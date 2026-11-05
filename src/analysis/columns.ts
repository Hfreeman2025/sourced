import { roundAmount } from '../lang/runtime';
import type { Expr, Program, Statement } from '../lang/types';
import { combineUnits, getUnit, powerUnit, rational, type Unit } from '../lang/units';

/** A quantity across every Monte Carlo run: one shared number when no
 * uncertain input reaches it, otherwise one value per run. */
export type Lane = number | Float64Array;
export interface Column {
  unit: Unit;
  lane: Lane;
}
type Datum = Column | Datum[];
interface Closure {
  statement: Extract<Statement, { kind: 'function' }>;
  env: Map<string, Datum>;
  functions: Map<string, Closure>;
}
export interface ColumnEvaluation {
  /** Aligned with `run(source).outputs`. A run where an output's own
   * calculation fails (a division by zero, a negative square root, a
   * non-finite step) holds NaN, which every later operation carries. */
  outputs: (Column | undefined)[];
  size: number;
}

/** Decimal rounding for a whole column. Away from a tie, Math.round(x · 10ᵖ)
 * / 10ᵖ is the same double as the interpreter's decimal shift; near a tie it
 * defers to that exact routine, so both evaluators always agree. */
export function roundColumn(lane: Float64Array, places: number): Float64Array {
  const scale = 10 ** places,
    out = new Float64Array(lane.length);
  for (let j = 0; j < lane.length; j++) {
    const value = lane[j] ?? Number.NaN,
      x = value * scale;
    const distance = Math.abs(x - Math.floor(x) - 0.5);
    out[j] =
      Math.abs(x) < 1e15 && distance > 1e-9 + Math.abs(x) * 1e-15
        ? Math.round(x) / scale + 0
        : roundAmount(value, places);
  }
  return out;
}

/** Evaluates a checked program once for all runs, column by column.
 *
 * Units are static (the checker has already proven them), so each operation
 * resolves its unit once and then loops over plain Float64Arrays. Every
 * operation mirrors the interpreter's arithmetic, in the same order, so a
 * column of central values reproduces the interpreter bit for bit. `inputs`
 * maps a literal's source offset to its sampled values. */
export function evaluateColumns(
  program: Program,
  inputs: ReadonlyMap<number, Float64Array>,
  size: number,
): ColumnEvaluation {
  const check = (lane: Lane): Lane => {
    // A shared number equals the checked central run, so it is already finite.
    if (typeof lane === 'number') return lane;
    for (let j = 0; j < size; j++)
      if (!Number.isFinite(lane[j] ?? Number.NaN)) lane[j] = Number.NaN;
    return lane;
  };
  // Sampled inputs are shared between Sobol's sample sets, so an overflowing
  // draw is marked undefined on a copy, never in place.
  const finite = new Map<number, Float64Array>();
  const sampled = (start: number): Float64Array | undefined => {
    const column = inputs.get(start);
    if (!column || column.every(Number.isFinite)) return column;
    let safe = finite.get(start);
    if (!safe) {
      safe = column.map((x) => (Number.isFinite(x) ? x : Number.NaN));
      finite.set(start, safe);
    }
    return safe;
  };
  const map = (a: Lane, f: (x: number) => number): Lane => {
    if (typeof a === 'number') return f(a);
    const out = new Float64Array(size);
    for (let j = 0; j < size; j++) out[j] = f(a[j] ?? Number.NaN);
    return check(out);
  };
  const zip = (a: Lane, b: Lane, f: (x: number, y: number) => number): Lane => {
    if (typeof a === 'number' && typeof b === 'number') return f(a, b);
    const out = new Float64Array(size);
    if (typeof a === 'number')
      for (let j = 0; j < size; j++) out[j] = f(a, (b as Float64Array)[j] ?? Number.NaN);
    else if (typeof b === 'number')
      for (let j = 0; j < size; j++) out[j] = f(a[j] ?? Number.NaN, b);
    else for (let j = 0; j < size; j++) out[j] = f(a[j] ?? Number.NaN, b[j] ?? Number.NaN);
    return check(out);
  };
  const quantity = (datum: Datum | undefined): Column => {
    if (!datum || Array.isArray(datum))
      throw new Error('A checked program produced a list where a quantity belongs.');
    return datum;
  };
  const evaluate = (expr: Expr, scope: Map<string, Datum>, fns: Map<string, Closure>): Datum => {
    switch (expr.kind) {
      case 'number':
        return { unit: getUnit(expr.unit, expr), lane: sampled(expr.start) ?? expr.value };
      case 'name': {
        const value = scope.get(expr.name);
        if (!value) throw new Error(`Unchecked name ${expr.name}.`);
        return value;
      }
      case 'list':
        return expr.items.map((item) => evaluate(item, scope, fns));
      case 'unary': {
        const value = quantity(evaluate(expr.value, scope, fns));
        return expr.op === '-' ? { unit: value.unit, lane: map(value.lane, (x) => -x) } : value;
      }
      case 'binary': {
        const a = quantity(evaluate(expr.left, scope, fns)),
          b = quantity(evaluate(expr.right, scope, fns));
        if (expr.op === '+' || expr.op === '-') {
          const bs = b.unit.scale,
            as = a.unit.scale;
          return {
            unit: a.unit,
            lane:
              expr.op === '+'
                ? zip(a.lane, b.lane, (x, y) => x + (y * bs) / as)
                : zip(a.lane, b.lane, (x, y) => x - (y * bs) / as),
          };
        }
        return {
          unit: combineUnits(a.unit, b.unit, expr.op === '*' ? '*' : '/'),
          lane:
            expr.op === '*'
              ? zip(a.lane, b.lane, (x, y) => x * y)
              : zip(a.lane, b.lane, (x, y) => (y === 0 ? Number.NaN : x / y)),
        };
      }
      case 'convert': {
        const value = quantity(evaluate(expr.value, scope, fns)),
          target = getUnit(expr.unit, expr);
        const vs = value.unit.scale,
          ts = target.scale;
        return { unit: target, lane: map(value.lane, (x) => (x * vs) / ts) };
      }
      case 'call': {
        const args = expr.args.map((arg) => evaluate(arg, scope, fns));
        if (expr.name === 'sum') {
          const list = args[0];
          if (!Array.isArray(list)) throw new Error('A checked sum received no list.');
          const values = list.map(quantity),
            first = values[0];
          if (!first) throw new Error('A checked sum received an empty list.');
          let lane: Lane = 0;
          for (const value of values) {
            const vs = value.unit.scale,
              fs = first.unit.scale;
            lane = zip(lane, value.lane, (x, y) => x + (y * vs) / fs);
          }
          return { unit: first.unit, lane };
        }
        if (expr.name === 'sqrt') {
          const value = quantity(args[0]);
          return { unit: powerUnit(value.unit, rational(1, 2)), lane: map(value.lane, Math.sqrt) };
        }
        if (expr.name === 'round') {
          const value = quantity(args[0]),
            places = quantity(args[1]).lane;
          if (typeof places !== 'number') throw new Error('Rounding precision is syntax.');
          return {
            unit: value.unit,
            lane:
              typeof value.lane === 'number'
                ? roundAmount(value.lane, places)
                : check(roundColumn(value.lane, places)),
          };
        }
        const fn = fns.get(expr.name);
        if (!fn) throw new Error(`Unchecked function ${expr.name}.`);
        const local = new Map(fn.env);
        fn.statement.params.forEach((name, i) => {
          const arg = args[i];
          if (arg) local.set(name, arg);
        });
        return evaluate(fn.statement.body, local, fn.functions);
      }
    }
  };
  const env = new Map<string, Datum>(),
    functions = new Map<string, Closure>(),
    outputs: (Column | undefined)[] = [];
  for (const statement of program.statements) {
    if (statement.kind === 'binding')
      env.set(statement.name, evaluate(statement.value, env, functions));
    if (statement.kind === 'function')
      functions.set(statement.name, {
        statement,
        env: new Map(env),
        functions: new Map(functions),
      });
    if (statement.kind === 'print') {
      const values = statement.parts.filter((part) => 'expr' in part);
      if (!values.length) outputs.push(undefined);
      for (const part of values)
        if ('expr' in part) outputs.push(quantity(evaluate(part.expr, env, functions)));
    }
  }
  return { outputs, size };
}

/** A column as one Float64Array; runs where it is undefined are NaN. */
export function expand(column: Column | undefined, evaluation: ColumnEvaluation): Float64Array {
  const out = new Float64Array(evaluation.size);
  if (!column) return out.fill(Number.NaN);
  if (typeof column.lane === 'number') out.fill(column.lane);
  else out.set(column.lane);
  return out;
}
