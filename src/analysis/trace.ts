import type { RunResult } from '../lang';
import { lex } from '../lang/lexer';
import { parse } from '../lang/parser';
import type { Expr, Span } from '../lang/types';
import { reachableNodes } from './sensitivity';
export function dependencyTokens(source: string, result: RunResult, index: number): Span[] {
  const reachable = reachableNodes(result, index),
    ranges: Span[] = [];
  result.nodes.forEach((node) => {
    if (reachable.has(node.id)) {
      ranges.push(node.span);
      if (node.source) ranges.push(node.source);
    }
  });
  const program = parse(source),
    usedFunctions = new Set<string>();
  const visit = (expr: Expr): void => {
    if (expr.kind === 'call') {
      usedFunctions.add(expr.name);
      expr.args.forEach((arg) => {
        visit(arg);
      });
    }
    if (expr.kind === 'binary') {
      visit(expr.left);
      visit(expr.right);
    }
    if (expr.kind === 'unary' || expr.kind === 'convert') visit(expr.value);
    if (expr.kind === 'list')
      expr.items.forEach((item) => {
        visit(item);
      });
  };
  for (const statement of program.statements) {
    if (
      statement.kind === 'binding' &&
      ranges.some((range) => range.start <= statement.start && range.end >= statement.end)
    )
      visit(statement.value);
  }
  // Follow lexical function definitions, including calls made by print expressions.
  const output = result.outputs[index];
  if (output)
    for (const statement of program.statements)
      if (statement.kind === 'print' && statement.start === output.span.start)
        statement.parts.forEach((part) => {
          if ('expr' in part) {
            ranges.push(part.expr);
            visit(part.expr);
          }
        });
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of program.statements)
      if (
        statement.kind === 'function' &&
        usedFunctions.has(statement.name) &&
        !ranges.includes(statement)
      ) {
        ranges.push(statement);
        visit(statement.body);
        changed = true;
      }
  }
  return lex(source)
    .tokens.filter(
      (token) =>
        !['eof', 'newline'].includes(token.kind) &&
        ranges.some((range) => token.start >= range.start && token.end <= range.end),
    )
    .map(({ start, end }) => ({ start, end }));
}
