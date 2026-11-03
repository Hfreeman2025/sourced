import {
  fail,
  LanguageError,
  type Diagnostic,
  type Expr,
  type Program,
  type Span,
  type Statement,
} from './types';
import {
  combineUnits,
  compatible,
  getUnit,
  powerUnit,
  rational,
  sameDimensions,
  type Unit,
} from './units';
import { resolveUncertainty } from './uncertainty';
type Shape = { kind: 'quantity'; unit: Unit } | { kind: 'list'; items: Shape[] };
interface FunctionDefinition {
  statement: Extract<Statement, { kind: 'function' }>;
  environment: Map<string, Shape>;
  functions: Map<string, FunctionDefinition>;
}
const builtins = ['sum', 'round', 'sqrt'];
class DependentError extends Error {}
export function check(program: Program): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let inferenceSteps = 0;
  const sources = new Set<string>();
  const failedNames = new Set<string>();
  const environment = new Map<string, Shape>();
  const functions = new Map<string, FunctionDefinition>();
  const names = new Set(builtins);
  const quantity = (shape: Shape, span: Span): Unit =>
    shape.kind === 'quantity'
      ? shape.unit
      : fail(
          span,
          'Expected a quantity',
          'A list cannot be used as a single number.',
          'Use sum(list) to add its values.',
        );
  const ensureLiterals = (expr: Expr, assumed: boolean, precision = false, depth = 0): void => {
    if (depth > 128)
      fail(
        expr,
        'Calculation too deep',
        'This expression exceeds 128 nested levels.',
        'Break the calculation into smaller named steps.',
      );
    if (expr.kind === 'number') {
      if (expr.source && failedNames.has(expr.source)) throw new DependentError();
      if (!expr.source && !assumed && !precision)
        fail(
          expr,
          'Every number needs a source',
          `“${expr.value}${expr.unit ? ` ${expr.unit}` : ''}” has no source.`,
          'Add @source.name, or declare it with assume.',
        );
      if (expr.source && !sources.has(expr.source))
        fail(
          expr,
          'Unknown source',
          `“${expr.source}” hasn’t been declared.`,
          `Add source ${expr.source} = "A description" before using it.`,
        );
      if (expr.source && !expr.unit)
        fail(
          expr,
          'A unit belongs here',
          'A sourced number needs a unit, even when it is dimensionless.',
          'Use a unit such as kWh, kg, %, or ratio.',
        );
      getUnit(expr.unit, expr);
      const uncertainty = expr.uncertainty;
      if (uncertainty) {
        if (precision)
          fail(
            uncertainty,
            'Invalid rounding precision',
            'Rounding precision can’t be uncertain.',
            'Precision is syntax. Put the uncertainty on the quantity you round.',
          );
        if (uncertainty.source && failedNames.has(uncertainty.source)) throw new DependentError();
        if (uncertainty.source && !sources.has(uncertainty.source))
          fail(
            uncertainty.provenance,
            'Unknown source',
            `“${uncertainty.source}” hasn’t been declared.`,
            `Add source ${uncertainty.source} = "A description" before citing it, or write assumed.`,
          );
        resolveUncertainty(expr.value, expr.unit, uncertainty);
      }
    }
    if (expr.kind === 'binary') {
      ensureLiterals(expr.left, assumed, false, depth + 1);
      ensureLiterals(expr.right, assumed, false, depth + 1);
    }
    if (expr.kind === 'unary' || expr.kind === 'convert')
      ensureLiterals(expr.value, assumed, false, depth + 1);
    if (expr.kind === 'list')
      expr.items.forEach((item) => {
        ensureLiterals(item, assumed, false, depth + 1);
      });
    if (expr.kind === 'call')
      expr.args.forEach((arg, i) => {
        ensureLiterals(
          arg,
          assumed,
          expr.name === 'round' && i === 1 && arg.kind === 'number' && !arg.unit && !arg.source,
          depth + 1,
        );
      });
  };
  const infer = (
    expr: Expr,
    env: Map<string, Shape>,
    fns: Map<string, FunctionDefinition>,
    depth = 0,
  ): Shape => {
    if (++inferenceSteps > 10000)
      return fail(
        expr,
        'Calculation too large',
        'This program requires more than 10,000 checking steps.',
        'Use fewer repeated function calls.',
      );
    if (depth > 32)
      return fail(
        expr,
        'Call limit reached',
        'This calculation is nested too deeply.',
        'Keep function calls below 32 levels. Recursion is not supported.',
      );
    const q = (unit: Unit): Shape => ({ kind: 'quantity', unit });
    switch (expr.kind) {
      case 'number':
        return q(getUnit(expr.unit, expr));
      case 'name':
        if (failedNames.has(expr.name)) throw new DependentError();
        return (
          env.get(expr.name) ??
          fail(
            expr,
            'Unknown name',
            `“${expr.name}” hasn’t been defined.`,
            'Declare it with let or assume before using it.',
          )
        );
      case 'list': {
        if (!expr.items.length)
          fail(
            expr,
            'Empty list',
            'An empty list has no unit to sum.',
            'Add at least one sourced value or assumption.',
          );
        return { kind: 'list', items: expr.items.map((item) => infer(item, env, fns, depth)) };
      }
      case 'unary':
        return q(quantity(infer(expr.value, env, fns, depth), expr));
      case 'binary': {
        const a = quantity(infer(expr.left, env, fns, depth), expr.left),
          b = quantity(infer(expr.right, env, fns, depth), expr.right);
        if (expr.op === '+' || expr.op === '-') {
          compatible(a, b, expr, expr.op === '+' ? 'adding' : 'subtracting');
          return q(a);
        }
        return q(combineUnits(a, b, expr.op === '*' ? '*' : '/'));
      }
      case 'convert': {
        const a = quantity(infer(expr.value, env, fns, depth), expr.value),
          b = getUnit(expr.unit, expr);
        compatible(a, b, expr, 'converting');
        return q(b);
      }
      case 'call': {
        if (failedNames.has(expr.name)) throw new DependentError();
        const args = expr.args.map((arg) => infer(arg, env, fns, depth));
        const count = (n: number) => {
          if (args.length !== n)
            fail(
              expr,
              'Wrong number of arguments',
              `${expr.name} expects ${n} argument${n === 1 ? '' : 's'}, but received ${args.length}.`,
              `Use ${expr.name}(${n === 2 ? 'value, 2' : 'value'}).`,
            );
        };
        if (expr.name === 'sum') {
          count(1);
          const list = args[0];
          if (list?.kind !== 'list')
            return fail(
              expr,
              'sum needs a list',
              'sum adds a list of quantities.',
              'Try sum([first, second]).',
            );
          const first = list.items[0];
          if (!first)
            return fail(
              expr,
              'Empty list',
              'An empty list has no unit.',
              'Add at least one value.',
            );
          const unit = quantity(first, expr);
          for (const item of list.items) compatible(unit, quantity(item, expr), expr);
          return q(unit);
        }
        if (expr.name === 'round') {
          count(2);
          const first = args[0],
            precision = expr.args[1];
          if (
            precision?.kind !== 'number' ||
            precision.unit ||
            precision.source ||
            precision.uncertainty ||
            !Number.isInteger(precision.value) ||
            precision.value < 0 ||
            precision.value > 8
          )
            fail(
              expr,
              'Invalid rounding precision',
              'round needs a literal precision from 0 to 8.',
              'Try round(total, 2). Precision is syntax, not an unsourced input.',
            );
          return q(quantity(first ?? q(getUnit('')), expr));
        }
        if (expr.name === 'sqrt') {
          count(1);
          return q(powerUnit(quantity(args[0] ?? q(getUnit('')), expr), rational(1, 2)));
        }
        const fn = fns.get(expr.name);
        if (!fn)
          return fail(
            expr,
            'Unknown function',
            `“${expr.name}” isn’t a function.`,
            'Use fn to declare it, or try sum, round or sqrt.',
          );
        count(fn.statement.params.length);
        const scope = new Map(fn.environment);
        fn.statement.params.forEach((name, i) => {
          const arg = args[i];
          if (arg) scope.set(name, arg);
        });
        return infer(fn.statement.body, scope, fn.functions, depth + 1);
      }
    }
  };
  const validateFunctionNames = (expr: Expr, params: string[]): void => {
    if ((expr.kind === 'name' || expr.kind === 'call') && failedNames.has(expr.name))
      throw new DependentError();
    if (expr.kind === 'name' && !params.includes(expr.name) && !environment.has(expr.name))
      fail(
        expr,
        'Unknown name',
        `“${expr.name}” hasn’t been defined.`,
        'Use a parameter or a previously declared value.',
      );
    if (expr.kind === 'call' && !builtins.includes(expr.name) && !functions.has(expr.name))
      fail(
        expr,
        'Unknown function',
        `“${expr.name}” isn’t a previously declared function.`,
        'Declare functions before calling them. Recursion is not supported.',
      );
    if (expr.kind === 'binary') {
      validateFunctionNames(expr.left, params);
      validateFunctionNames(expr.right, params);
    }
    if (expr.kind === 'unary' || expr.kind === 'convert') validateFunctionNames(expr.value, params);
    if (expr.kind === 'list')
      expr.items.forEach((item) => {
        validateFunctionNames(item, params);
      });
    if (expr.kind === 'call')
      expr.args.forEach((arg) => {
        validateFunctionNames(arg, params);
      });
  };
  for (const statement of program.statements) {
    try {
      if ('name' in statement && names.has(statement.name))
        fail(
          statement,
          'Name already used',
          `“${statement.name}” is already declared or reserved.`,
          'Choose a different name; bindings are immutable.',
        );
      switch (statement.kind) {
        case 'source': {
          if (statement.url) {
            let protocol = '';
            try {
              protocol = new URL(statement.url).protocol;
            } catch {
              fail(
                statement,
                'Invalid source URL',
                'This source URL is not a valid absolute address.',
                'Use a complete https:// address.',
              );
            }
            if (!['https:', 'http:'].includes(protocol))
              fail(
                statement,
                'Invalid source URL',
                'Source links must use HTTP or HTTPS.',
                'Use a public https:// source link.',
              );
          }
          sources.add(statement.name);
          names.add(statement.name);
          break;
        }
        case 'function': {
          if (new Set(statement.params).size !== statement.params.length)
            fail(
              statement,
              'Repeated parameter',
              'Each function parameter needs its own name.',
              'Rename the repeated parameter.',
            );
          ensureLiterals(statement.body, false);
          validateFunctionNames(statement.body, statement.params);
          functions.set(statement.name, {
            statement,
            environment: new Map(environment),
            functions: new Map(functions),
          });
          names.add(statement.name);
          break;
        }
        case 'binding': {
          ensureLiterals(statement.value, statement.assume);
          const value = infer(statement.value, environment, functions);
          environment.set(statement.name, value);
          names.add(statement.name);
          break;
        }
        case 'print':
          for (const part of statement.parts)
            if ('expr' in part) {
              ensureLiterals(part.expr, false);
              quantity(infer(part.expr, environment, functions), part.expr);
            }
          break;
      }
    } catch (error) {
      if (error instanceof LanguageError || error instanceof DependentError) {
        if (error instanceof LanguageError) diagnostics.push(error.diagnostic);
        if ('name' in statement && !names.has(statement.name)) failedNames.add(statement.name);
      } else throw error;
    }
  }
  return diagnostics;
}
export const dimensionless = (unit: Unit): boolean => sameDimensions(unit.dimensions, {});
