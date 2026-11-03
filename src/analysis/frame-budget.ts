import { parse } from '../lang/parser';
import type { Expr } from '../lang/types';
/** A small, structural budget for one per-frame interpreter pass. Complex
 * programs never enter this path; all finite-difference scans use the worker. */
export function canEvaluateInFrame(source: string): boolean {
  if (source.length > 1000) return false;
  const program = parse(source);
  let nodes = 0,
    calls = 0,
    functions = 0;
  const visit = (expr: Expr): void => {
    nodes++;
    if (nodes > 100 || calls > 8) return;
    if (expr.kind === 'binary') {
      visit(expr.left);
      visit(expr.right);
    }
    if (expr.kind === 'unary' || expr.kind === 'convert') visit(expr.value);
    if (expr.kind === 'list')
      expr.items.forEach((item) => {
        visit(item);
      });
    if (expr.kind === 'call') {
      calls++;
      expr.args.forEach((arg) => {
        visit(arg);
      });
    }
  };
  for (const statement of program.statements) {
    if (statement.kind === 'binding') visit(statement.value);
    if (statement.kind === 'function') {
      functions++;
      visit(statement.body);
    }
    if (statement.kind === 'print')
      statement.parts.forEach((part) => {
        if ('expr' in part) visit(part.expr);
      });
  }
  return functions <= 2 && nodes <= 100 && calls <= 8;
}
