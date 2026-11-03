import { createRuntime, type Datum, type Evaluation } from './runtime';
import { fail, type Expr, type Program, type Statement } from './types';
interface Closure {
  statement: Extract<Statement, { kind: 'function' }>;
  env: Map<string, Datum>;
  functions: Map<string, Closure>;
}
export function interpret(program: Program): Evaluation {
  const rt = createRuntime();
  const env = new Map<string, Datum>(),
    functions = new Map<string, Closure>();
  const evaluate = (
    expr: Expr,
    scope: Map<string, Datum>,
    fns: Map<string, Closure>,
    assumption?: string,
  ): Datum => {
    const at = { start: expr.start, end: expr.end };
    switch (expr.kind) {
      case 'number':
        return rt.number(expr.value, expr.unit, expr.source, assumption, at, expr.uncertainty);
      case 'name':
        return (
          scope.get(expr.name) ??
          fail(expr, 'Unknown name', `Unknown name ${expr.name}.`, 'Declare the name first.')
        );
      case 'list':
        return expr.items.map((item) => evaluate(item, scope, fns, assumption));
      case 'unary':
        return rt.unary(expr.op, evaluate(expr.value, scope, fns, assumption), at);
      case 'binary':
        return rt.binary(
          expr.op,
          evaluate(expr.left, scope, fns, assumption),
          evaluate(expr.right, scope, fns, assumption),
          at,
        );
      case 'convert':
        return rt.convert(evaluate(expr.value, scope, fns, assumption), expr.unit, at);
      case 'call': {
        const args = expr.args.map((arg) => evaluate(arg, scope, fns, assumption));
        if (['sum', 'sqrt', 'round'].includes(expr.name)) return rt.builtin(expr.name, args, at);
        const fn = fns.get(expr.name);
        if (!fn)
          return fail(
            expr,
            'Unknown function',
            `Unknown function ${expr.name}.`,
            'Declare the function first.',
          );
        const local = new Map(fn.env);
        fn.statement.params.forEach((name, i) => {
          const arg = args[i];
          if (arg) local.set(name, arg);
        });
        return evaluate(fn.statement.body, local, fn.functions);
      }
    }
  };
  for (const statement of program.statements) {
    switch (statement.kind) {
      case 'source':
        rt.source(statement);
        break;
      case 'binding':
        env.set(
          statement.name,
          rt.bind(
            statement.name,
            evaluate(
              statement.value,
              env,
              functions,
              statement.assume ? statement.name : undefined,
            ),
            statement.assume,
            statement,
          ),
        );
        break;
      case 'function':
        functions.set(statement.name, {
          statement,
          env: new Map(env),
          functions: new Map(functions),
        });
        break;
      case 'print':
        rt.print(
          statement.parts.map((part) =>
            'text' in part ? part.text : evaluate(part.expr, env, functions),
          ),
          statement,
        );
        break;
    }
  }
  return rt.result();
}
