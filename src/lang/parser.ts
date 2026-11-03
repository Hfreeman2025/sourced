import { lex } from './lexer';
import {
  fail,
  LanguageError,
  type Expr,
  type Part,
  type Amount,
  type Program,
  type Spread,
  type Statement,
  type Token,
  type Uncertainty,
} from './types';
import { isUnit } from './units';
class Parser {
  private index = 0;
  private nesting = 0;
  constructor(private tokens: Token[]) {}
  peek(): Token {
    return this.tokens[this.index] ?? { kind: 'eof', text: '', start: 0, end: 0 };
  }
  next(): Token {
    const token = this.peek();
    this.index++;
    return token;
  }
  match(text: string): boolean {
    if (this.peek().text === text) {
      this.next();
      return true;
    }
    return false;
  }
  expect(text: string): Token {
    const token = this.next();
    if (token.text !== text)
      fail(
        token,
        'Something’s missing',
        `Expected “${text}”, but found ${token.text ? `“${token.text}”` : 'the end of the program'}.`,
        `Add “${text}” here.`,
      );
    return token;
  }
  identifier(): Token {
    const token = this.next();
    if (token.kind !== 'id')
      fail(
        token,
        'A name belongs here',
        'Expected a name.',
        'Try a name such as usage or invoice.march.',
      );
    return token;
  }
  string(): Token {
    const token = this.next();
    if (token.kind !== 'string')
      fail(
        token,
        'A description belongs here',
        'Expected a quoted description.',
        'Put the text inside double quotes.',
      );
    return token;
  }
  skipLines() {
    while (this.peek().kind === 'newline') this.next();
  }
  unit(): string {
    const first = this.next();
    let text = first.text;
    if (!isUnit(text))
      fail(
        first,
        'Unknown unit',
        `“${text}” is not a known unit.`,
        'Try kg, kWh, km, L, £, %, or a compound such as kg/kWh.',
      );
    const exponent = () => {
      if (this.match('^')) {
        text += '^';
        if (this.match('(')) {
          text += '(';
          if (this.match('-')) text += '-';
          const n = this.next();
          if (n.kind !== 'number' || !/^\d+$/.test(n.text) || Number(n.text) > 32)
            fail(
              n,
              'Invalid exponent',
              'Unit exponents must use integers from −32 to 32.',
              'Try m^2 or m^(1/2).',
            );
          text += n.text;
          this.expect('/');
          const d = this.next();
          if (d.kind !== 'number' || !/^[1-9]\d*$/.test(d.text) || Number(d.text) > 32)
            fail(
              d,
              'Invalid exponent',
              'A rational denominator must be an integer from 1 to 32.',
              'Try m^(1/2).',
            );
          text += `/${d.text}`;
          this.expect(')');
          text += ')';
        } else {
          if (this.match('-')) text += '-';
          const n = this.next();
          if (n.kind !== 'number' || !/^\d+$/.test(n.text) || Number(n.text) > 32)
            fail(
              n,
              'Invalid exponent',
              'Unit exponents must use integers from −32 to 32.',
              'Try m^2 or m^(1/2).',
            );
          text += n.text;
        }
      }
    };
    exponent();
    while (
      ['*', '/'].includes(this.peek().text) &&
      isUnit(this.tokens[this.index + 1]?.text ?? '')
    ) {
      text += this.next().text + this.next().text;
      exponent();
    }
    return text;
  }
  /** A number in an uncertainty clause: optional sign, value, optional unit. */
  private amount(): Amount {
    const first = this.peek();
    const negative = this.match('-');
    const token = this.next();
    if (token.kind !== 'number')
      fail(
        token,
        'A number belongs here',
        `Expected a number in this uncertainty, but found ${token.text ? `“${token.text}”` : 'the end of the line'}.`,
        'Try ±5%, 0.72..0.775, 95% 67500..73000 or normal(5%).',
      );
    const value = Number(token.text.replaceAll('_', '')) * (negative ? -1 : 1);
    if (!Number.isFinite(value))
      fail(token, 'Number too large', 'This number is outside the finite range.', 'Use a smaller value.');
    const unit = isUnit(this.peek().text) ? this.unit() : '';
    return { value, unit, start: first.start, end: this.tokens[this.index - 1]?.end ?? token.end };
  }
  private spread(): Spread {
    const first = this.peek();
    const end = () => this.tokens[this.index - 1]?.end ?? first.end;
    if (first.text === '±' || (first.text === '+' && this.tokens[this.index + 1]?.text === '-')) {
      this.next();
      if (first.text === '+') this.next();
      const width = this.amount();
      return { kind: 'plusminus', width, start: first.start, end: width.end };
    }
    const named = ['normal', 'lognormal', 'triangular', 'uniform'];
    if (first.kind === 'id' && named.includes(first.text) && this.tokens[this.index + 1]?.text === '(') {
      this.next();
      this.expect('(');
      if (first.text === 'normal') {
        const sd = this.amount();
        this.expect(')');
        return { kind: 'normal', sd, start: first.start, end: end() };
      }
      if (first.text === 'lognormal') {
        const factor = this.amount();
        this.expect(')');
        return { kind: 'lognormal', factor, start: first.start, end: end() };
      }
      const low = this.amount();
      this.expect(',');
      const high = this.amount();
      this.expect(')');
      return first.text === 'triangular'
        ? { kind: 'triangular', low, high, start: first.start, end: end() }
        : { kind: 'range', low, high, named: true, start: first.start, end: end() };
    }
    if (first.kind === 'number' || first.text === '-') {
      const a = this.amount();
      if (this.match('..')) {
        const high = this.amount();
        return { kind: 'range', low: a, high, start: a.start, end: high.end };
      }
      if (a.unit === '%' && (this.peek().kind === 'number' || this.peek().text === '-')) {
        const low = this.amount();
        this.expect('..');
        const high = this.amount();
        return { kind: 'range', coverage: a, low, high, start: a.start, end: high.end };
      }
      return fail(
        this.peek(),
        'Unfinished range',
        'A range needs a lower and an upper bound.',
        'Write low..high, such as 0.72..0.775, or 95% low..high for a stated interval.',
      );
    }
    return fail(
      first,
      'Unknown uncertainty',
      `I don’t recognise ${first.text ? `“${first.text}”` : 'the end of the line'} as a spread.`,
      'Use ±5%, low..high, 95% low..high, normal(5%), lognormal(1.2) or triangular(low, high).',
    );
  }
  private uncertainty(): Uncertainty {
    const tilde = this.next();
    const spread = this.spread();
    const marker = this.peek();
    let source: string | undefined;
    if (this.match('@')) source = this.identifier().text;
    else if (marker.text === 'assumed') this.next();
    else
      fail(
        marker,
        'Uncertainty needs a source',
        'Every spread says who stands behind it.',
        'End the clause with @source.name, or with assumed.',
      );
    const end = this.tokens[this.index - 1]?.end ?? marker.end;
    return { spread, source, provenance: { start: marker.start, end }, start: tilde.start, end };
  }
  private innerLines() {
    while (this.peek().kind === 'newline') {
      if (
        ['source', 'let', 'assume', 'fn', 'print'].includes(this.tokens[this.index + 1]?.text ?? '')
      )
        fail(
          this.peek(),
          'Unfinished expression',
          'This expression ends before its closing delimiter.',
          'Close the previous expression before starting a new statement.',
        );
      this.next();
    }
  }
  expression(min = 0): Expr {
    if (++this.nesting > 128) {
      this.nesting--;
      return fail(
        this.peek(),
        'Calculation too deep',
        'This expression exceeds 128 nested levels.',
        'Break the calculation into smaller named steps.',
      );
    }
    try {
      return this.parseExpression(min);
    } finally {
      this.nesting--;
    }
  }
  private parseExpression(min = 0): Expr {
    const token = this.next();
    let left: Expr;
    // A minus written directly before a number is part of that literal, so a
    // spread such as `-5 kg ~ -6..-4 assumed` describes the signed quantity.
    const signed = token.text === '-' && this.peek().kind === 'number';
    const literal = signed ? this.next() : token;
    if (literal.kind === 'number') {
      const value = Number(literal.text.replaceAll('_', '')) * (signed ? -1 : 1);
      if (!Number.isFinite(value))
        fail(
          literal,
          'Number too large',
          'This number is outside the finite range.',
          'Use a smaller value.',
        );
      let unit = '';
      if (isUnit(this.peek().text)) unit = this.unit();
      const source = this.match('@') ? this.identifier().text : undefined;
      const uncertainty = this.peek().text === '~' ? this.uncertainty() : undefined;
      left = {
        kind: 'number',
        value,
        unit,
        source,
        ...(uncertainty ? { uncertainty } : {}),
        start: token.start,
        end: this.tokens[this.index - 1]?.end ?? token.end,
      };
    } else if (token.text === '-' || token.text === '+') {
      const value = this.expression(30);
      left = { kind: 'unary', op: token.text, value, start: token.start, end: value.end };
    } else if (token.text === '(') {
      this.innerLines();
      left = this.expression();
      this.innerLines();
      this.expect(')');
    } else if (token.text === '[') {
      const items: Expr[] = [];
      this.innerLines();
      if (!this.match(']')) {
        do {
          this.innerLines();
          items.push(this.expression());
          this.innerLines();
        } while (this.match(','));
        this.expect(']');
      }
      left = {
        kind: 'list',
        items,
        start: token.start,
        end: this.tokens[this.index - 1]?.end ?? token.end,
      };
    } else if (token.kind === 'id') {
      if (this.match('(')) {
        const args: Expr[] = [];
        this.innerLines();
        if (!this.match(')')) {
          do {
            this.innerLines();
            args.push(this.expression());
            this.innerLines();
          } while (this.match(','));
          this.expect(')');
        }
        left = {
          kind: 'call',
          name: token.text,
          args,
          start: token.start,
          end: this.tokens[this.index - 1]?.end ?? token.end,
        };
      } else left = { kind: 'name', name: token.text, start: token.start, end: token.end };
    } else
      return fail(
        token,
        'Expected a calculation',
        `I expected a value, but found ${token.text ? `“${token.text}”` : 'the end of the program'}.`,
        'Try 284 kWh @bill, an assumption, or an existing name.',
      );
    while (true) {
      const op = this.peek();
      if (op.text === 'as' && min <= 5) {
        this.next();
        const unit = this.unit();
        left = {
          kind: 'convert',
          value: left,
          unit,
          start: left.start,
          end: this.tokens[this.index - 1]?.end ?? op.end,
        };
        continue;
      }
      const precedence = ['+', '-'].includes(op.text) ? 10 : ['*', '/'].includes(op.text) ? 20 : 0;
      if (!precedence || precedence < min) break;
      this.next();
      const right = this.expression(precedence + 1);
      left = { kind: 'binary', op: op.text, left, right, start: left.start, end: right.end };
    }
    return left;
  }
  statement(): Statement {
    const token = this.next(),
      start = token.start;
    if (token.text === 'source') {
      const name = this.identifier().text;
      this.expect('=');
      const title = this.string().text;
      const fields: { page?: string; url?: string; year?: string } = {};
      while (this.match(',')) {
        const key = this.identifier();
        const value = this.next();
        if (
          !['page', 'url', 'year'].includes(key.text) ||
          !['string', 'number'].includes(value.kind)
        )
          fail(
            key,
            'Unknown source detail',
            'Source details are page, url and year.',
            'Use page 2, year 2006, or url "https://…".',
          );
        if (key.text === 'url') fields.url = value.text;
        if (key.text === 'page') fields.page = value.text;
        if (key.text === 'year') fields.year = value.text;
      }
      return {
        kind: 'source',
        name,
        title,
        ...fields,
        start,
        end: this.tokens[this.index - 1]?.end ?? token.end,
      };
    }
    if (token.text === 'let' || token.text === 'assume') {
      const name = this.identifier().text;
      this.expect('=');
      const value = this.expression();
      return {
        kind: 'binding',
        name,
        assume: token.text === 'assume',
        value,
        start,
        end: value.end,
      };
    }
    if (token.text === 'fn') {
      const name = this.identifier().text;
      this.expect('(');
      const params: string[] = [];
      if (!this.match(')')) {
        do {
          params.push(this.identifier().text);
        } while (this.match(','));
        this.expect(')');
      }
      this.expect('=');
      const body = this.expression();
      return { kind: 'function', name, params, body, start, end: body.end };
    }
    if (token.text === 'print') {
      const string = this.string(),
        parts: Part[] = [];
      let cursor = 0;
      for (const match of string.text.matchAll(/\{([^{}]*)\}/g)) {
        const at = match.index;
        parts.push({ text: string.text.slice(cursor, at) });
        const result = lex(match[1] ?? '');
        const rawOffset = (index: number) =>
          string.offsets?.[at + 1 + index] ?? string.start + 1 + at + 1 + index;
        result.tokens.forEach((token) => {
          token.start = rawOffset(token.start);
          token.end = rawOffset(token.end);
        });
        result.diagnostics.forEach((diagnostic) => {
          diagnostic.start = rawOffset(diagnostic.start);
          diagnostic.end = rawOffset(diagnostic.end);
        });
        if (result.diagnostics[0]) throw new LanguageError(result.diagnostics[0]);
        const parser = new Parser(result.tokens);
        const expr = parser.expression();
        if (parser.peek().kind !== 'eof')
          fail(
            parser.peek(),
            'Unexpected expression',
            'There is extra text inside this interpolation.',
            'Use one calculation inside each pair of braces.',
          );
        parts.push({ expr });
        cursor = at + match[0].length;
      }
      const tail = string.text.slice(cursor);
      if (/[{}]/.test(tail) || parts.some((part) => 'text' in part && /[{}]/.test(part.text)))
        fail(
          string,
          'Unfinished interpolation',
          'Interpolation needs matching { and } braces.',
          'Try print "Total: {total}".',
        );
      parts.push({ text: tail });
      return { kind: 'print', parts, start, end: string.end };
    }
    return fail(
      token,
      'Unknown statement',
      `“${token.text}” can’t start a statement.`,
      'Start with source, assume, let, fn or print.',
    );
  }
}
export function parse(source: string): Program {
  if (source.length > 30000)
    return {
      statements: [],
      diagnostics: [
        {
          start: 0,
          end: 1,
          title: 'Program too long',
          message: 'This playground accepts up to 30,000 characters.',
          hint: 'Split this calculation into smaller programs.',
        },
      ],
    };
  const { tokens, diagnostics } = lex(source);
  const parser = new Parser(tokens);
  const statements: Statement[] = [];
  while (parser.peek().kind !== 'eof') {
    parser.skipLines();
    if (parser.peek().kind === 'eof') break;
    try {
      statements.push(parser.statement());
      if (!['newline', 'eof'].includes(parser.peek().kind))
        fail(
          parser.peek(),
          'One statement at a time',
          'There is extra text after this statement.',
          'Put the next statement on a new line.',
        );
    } catch (error) {
      if (error instanceof LanguageError) diagnostics.push(error.diagnostic);
      else throw error;
      while (!['newline', 'eof'].includes(parser.peek().kind)) parser.next();
    }
    parser.skipLines();
  }
  return { statements, diagnostics };
}
