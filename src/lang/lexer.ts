import { LanguageError, type Diagnostic, type Token } from './types';
export function lex(input: string, offset = 0): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [],
    diagnostics: Diagnostic[] = [];
  let i = 0;
  const push = (kind: Token['kind'], text: string, start: number, end: number) =>
    tokens.push({ kind, text, start: start + offset, end: end + offset });
  while (i < input.length) {
    const c = input[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      push('newline', c, i, ++i);
      continue;
    }
    if (input.slice(i, i + 2) === '//') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c)) {
      const text =
        /^\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d+)?/.exec(input.slice(i))?.[0] ?? c;
      i += text.length;
      push('number', text, start, i);
      continue;
    }
    if (/[a-zA-Z_Ω]/.test(c)) {
      // A dot joins name parts (invoice.march) only when a name character
      // follows, so `4 km..6 km` is a unit, a range and a unit.
      const text =
        /^[a-zA-Z_Ω](?:[a-zA-Z0-9_Ω]|\.(?=[a-zA-Z0-9_Ω]))*/.exec(input.slice(i))?.[0] ?? c;
      i += text.length;
      push('id', text, start, i);
      continue;
    }
    if (c === '"') {
      i++;
      let value = '';
      let closed = false;
      const offsets: number[] = [];
      while (i < input.length && input[i] !== '\n') {
        if (input[i] === '"') {
          i++;
          closed = true;
          break;
        }
        offsets.push(i + offset);
        if (input[i] === '\\' && input[i + 1]) {
          const next = input[++i] ?? '';
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i++;
        } else value += input[i++];
      }
      if (!closed)
        diagnostics.push({
          start: start + offset,
          end: i + offset,
          title: 'Unfinished string',
          message: 'This string needs a closing quote.',
          hint: 'Add a double quote before the end of this line.',
        });
      push('string', value, start, i);
      const token = tokens.at(-1);
      if (token) token.offsets = offsets;
      continue;
    }
    if (input.slice(i, i + 2) === '..') {
      push('symbol', '..', i, i + 2);
      i += 2;
      continue;
    }
    if ('+-*/^=()[],@£%~±'.includes(c)) {
      push('symbol', c, i, ++i);
      continue;
    }
    diagnostics.push({
      start: i + offset,
      end: i + offset + 1,
      title: 'Unexpected character',
      message: `I don’t recognise “${c}”.`,
      hint: 'Use +, -, *, / for arithmetic and @ for a source.',
    });
    i++;
  }
  push('eof', '', i, i);
  return { tokens, diagnostics };
}
export function formatDiagnostic(source: string, d: Diagnostic): string {
  const before = source.slice(0, d.start),
    line = before.split('\n').length;
  const column = d.start - before.lastIndexOf('\n');
  const text = source.split('\n')[line - 1] ?? '';
  return `${d.title} at ${line}:${column}\n${line} | ${text}\n${' '.repeat(String(line).length + 3 + column - 1)}${'^'.repeat(Math.max(1, Math.min(d.end - d.start, text.length - column + 1)))}\n${d.message}\n${d.hint}`;
}
export { LanguageError };
