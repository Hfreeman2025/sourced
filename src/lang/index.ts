import { parse } from './parser';
import { check } from './checker';
import { interpret } from './interpreter';
import { LanguageError, type Diagnostic } from './types';
import type { Evaluation } from './runtime';
export interface RunResult extends Evaluation {
  diagnostics: Diagnostic[];
}
export function run(source: string): RunResult {
  const empty = { outputs: [], nodes: [], bindings: {} };
  const program = parse(source);
  if (program.diagnostics.length) return { ...empty, diagnostics: program.diagnostics };
  const diagnostics = check(program);
  if (diagnostics.length) return { ...empty, diagnostics };
  try {
    return { ...interpret(program), diagnostics: [] };
  } catch (error) {
    if (error instanceof LanguageError) return { ...empty, diagnostics: [error.diagnostic] };
    if (error instanceof RangeError)
      return {
        ...empty,
        diagnostics: [
          {
            start: 0,
            end: 1,
            title: 'Calculation too deep',
            message: 'This program exceeds the nesting limit.',
            hint: 'Break long calculations into smaller named steps.',
          },
        ],
      };
    throw error;
  }
}
export { parse, check, interpret };
export { compile } from './compiler';
export { createRuntime, formatValue, formatNumber } from './runtime';
