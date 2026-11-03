import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, parse, check, interpret, compile, createRuntime, formatValue } from '../src/lang';
import { lex, formatDiagnostic } from '../src/lang/lexer';
import { getUnit, combineUnits, powerUnit, rational, sameDimensions } from '../src/lang/units';
import { examples } from '../src/examples';
import { runInNewContext } from 'node:vm';
import type { Evaluation } from '../src/lang/runtime';
const first = (source: string): number | undefined => {
  const result = run(source);
  assert.deepEqual(result.diagnostics, [], source);
  return result.outputs[0]?.value?.amount;
};
const compiled = (source: string): Evaluation => {
  const body = compile(parse(source));
  const value: Evaluation = runInNewContext(
    `(function(rt) { ${body} })`,
    {},
    { timeout: 1000 },
  )(createRuntime());
  return value;
};
test('lexer recognises separators, decimals, scientific notation, sources and comments', () => {
  const result = lex('14_200.5 kWh @invoice.march // comment\n1e3');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((t) => [t.kind, t.text]),
    [
      ['number', '14_200.5'],
      ['id', 'kWh'],
      ['symbol', '@'],
      ['id', 'invoice.march'],
      ['newline', '\n'],
      ['number', '1e3'],
      ['eof', ''],
    ],
  );
  assert.deepEqual(result.tokens[0], { kind: 'number', text: '14_200.5', start: 0, end: 8 });
});
test('lexer reports unclosed strings and unknown characters without losing later lines', () => {
  const result = lex('source bad = "open\n?\nassume x = 2');
  assert.deepEqual(
    result.diagnostics.map((d) => d.title),
    ['Unfinished string', 'Unexpected character'],
  );
  assert.ok(result.tokens.some((token) => token.text === 'assume'));
});
test('Pratt precedence, unary and parentheses', () => {
  assert.equal(first('assume x = -2 + 3 * (4 + 1)\nprint "Answer: {x}"'), 13);
  assert.equal(first('assume x = 20 / 2 / 2\nprint "Answer: {x}"'), 5);
});
test('parser recovers at line boundaries, returning precise errors and valid later statements', () => {
  const program = parse('let x = )\nlet y = (\nassume fine = 3\nprint "Good: {fine}"');
  assert.equal(program.diagnostics.length, 2);
  assert.equal(program.diagnostics[0]?.start, 8);
  assert.deepEqual(
    program.statements.map((s) => s.kind),
    ['binding', 'print'],
  );
});
test('multiline lists and calls, semicolons', () => {
  assert.equal(
    first(
      'assume a = 1; assume b = 2\nlet c = sum([\na,\nb\n])\nlet d = round(\nc,\n2\n)\nprint "Total: {d}"',
    ),
    3,
  );
});
test('all examples have concrete expected results and backends agree, including complete lineage', () => {
  const answers: Record<string, number> = {
    commute: 70.88,
    solar: 9.86,
    home: 85.7,
    trip: 28.39,
    recipe: 450,
  };
  examples.forEach((example) => {
    const program = parse(example.code);
    assert.deepEqual(program.diagnostics, [], example.id);
    assert.deepEqual(check(program), [], example.id);
    const evaluated = interpret(program);
    assert.equal(evaluated.outputs[0]?.value?.amount, answers[example.id], example.id);
    const js = compiled(example.code);
    // JSON normalises cross-realm arrays from the generated backend.
    assert.deepEqual(
      JSON.parse(JSON.stringify(js)),
      JSON.parse(JSON.stringify(evaluated)),
      example.id,
    );
  });
});
test('sourced dimensionless values need an explicit ratio unit', () => {
  assert.equal(run('source a = "a"\nlet x = 3 @a').diagnostics[0]?.title, 'A unit belongs here');
  assert.equal(first('source a = "a"\nlet x = 3 ratio @a\nprint "x: {x}"'), 3);
});
test('source must be declared; duplicate definitions and reserved builtins fail', () => {
  assert.equal(run('let x = 2 kg @missing').diagnostics[0]?.title, 'Unknown source');
  for (const source of [
    'assume x = 2\nassume x = 3',
    'assume sum = 3',
    'source x = "a"\nassume x = 2',
  ])
    assert.equal(run(source).diagnostics[0]?.title, 'Name already used');
});
test('source metadata, safe URLs, and interpolation', () => {
  const result = run(
    'source a = "Published figure", page 2, year 2006, url "https://example.com/data"\nlet x = 2 kg @a\nprint "Mass: {x}; again {x as g}."',
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.outputs[0]?.text, 'Mass: 2 kg; again 2,000 g.');
  assert.equal(result.nodes[0]?.source?.year, '2006');
  assert.equal(
    run('source a = "a", url "javascript:alert(1)"').diagnostics[0]?.title,
    'Invalid source URL',
  );
  assert.equal(run('print "Broken {oops"').diagnostics[0]?.title, 'Unfinished interpolation');
});
test('addition converts compatible units and rejects incompatible quantities', () => {
  assert.equal(first('assume a = 1 kg\nassume b = 500 g\nlet c = a + b\nprint "Mass: {c}"'), 1.5);
  const source =
    'source invoice = "Example invoice"\nlet energy = 10 kWh @invoice\nlet mass = 2 kg @invoice\nlet total = energy + mass';
  const d = run(source).diagnostics[0];
  assert.ok(d);
  assert.equal(
    formatDiagnostic(source, d),
    'Units don’t add up at 4:13\n4 | let total = energy + mass\n                ^^^^^^^^^^^^^\nYou’re adding kWh to kg.\nDid you mean to multiply by an emission factor (kg/kWh)?',
  );
});
test('conversion errors, division by zero, bad roots, arity and list errors are explicit', () => {
  const cases = [
    ['assume a = 1 kg\nlet b = a as km', 'Units don’t add up'],
    ['assume x = 2 / 0', 'Division by zero'],
    ['assume x = sqrt(-1)', 'No real square root'],
    ['assume x = sum(2)', 'sum needs a list'],
    ['assume x = sum([])', 'Empty list'],
    ['assume x = [1, 2] + 3', 'Expected a quantity'],
    ['assume x = sum([1 kg, 2 km])', 'Units don’t add up'],
    ['assume x = round(1, 9)', 'Invalid rounding precision'],
    ['assume p = 2\nassume x = round(1, p)', 'Invalid rounding precision'],
    ['assume x = sqrt(1, 2)', 'Wrong number of arguments'],
    ['assume x = 1e309', 'Number too large'],
    ['assume x = 1e308 * 1e308', 'Non-finite result'],
    ['assume x = 1 m^(1/0)', 'Invalid exponent'],
  ];
  for (const [source, title] of cases) {
    assert.ok(source);
    assert.equal(run(source).diagnostics[0]?.title, title, source);
  }
});
test('provenance unions inputs, deduplicates dependencies, and retains repeated derivation branches', () => {
  const result = run(
    'source meter = "Meter"\nlet x = 2 kWh @meter\nassume factor = 0.2 kg/kWh\nlet y = x * factor + x * factor\nprint "Carbon: {y}"',
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.outputs[0]?.value?.amount, 0.8);
  assert.deepEqual(result.outputs[0]?.value?.dependencies, ['assumption:factor', 'source:meter']);
  const node = result.nodes.find((n) => n.id === result.outputs[0]?.value?.node);
  assert.ok(node);
  assert.equal(result.nodes.filter((n) => n.label === 'multiply').length, 2);
  assert.ok(result.nodes.some((n) => n.kind === 'assumption' && n.label === 'factor'));
});
test('a sourced value inside assume still retains the source and the assumption', () => {
  const result = run('source s = "Source"\nassume x = 2 kg @s\nprint "x: {x}"');
  assert.deepEqual(result.outputs[0]?.value?.dependencies, ['assumption:x', 'source:s']);
});
test('functions are unit polymorphic and capture their lexical environment', () => {
  const source =
    'assume factor = 2\nfn double(x) = x * factor\nassume a = 3 kg\nassume b = 4 km\nlet aa = double(a)\nlet bb = double(b)\nprint "A: {aa}"\nprint "B: {bb}"';
  assert.deepEqual(
    run(source).outputs.map((o) => formatValue(o.value ?? { amount: 0, unit: '' })),
    ['6 kg', '8 km'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(compiled(source))),
    JSON.parse(JSON.stringify(interpret(parse(source)))),
  );
  assert.equal(run('fn f(x) = f(x)').diagnostics[0]?.title, 'Unknown function');
  assert.equal(run('fn f(x) = x * 2').diagnostics[0]?.title, 'Every number needs a source');
  assert.equal(run('fn f(x, x) = x').diagnostics[0]?.title, 'Repeated parameter');
  assert.equal(run('fn f(x) = missing').diagnostics[0]?.title, 'Unknown name');
  assert.equal(
    run('fn f(x, y) = x + y\nassume a = f(1 kg, 2 km)').diagnostics[0]?.title,
    'Units don’t add up',
  );
});
test('dimension algebra uses reduced rational exponents', () => {
  assert.deepEqual(rational(6, 4), { n: 3, d: 2 });
  const half = powerUnit(getUnit('m'), rational(1, 2));
  assert.ok(sameDimensions(combineUnits(half, half, '*').dimensions, getUnit('m').dimensions));
  assert.ok(sameDimensions(getUnit('J').dimensions, getUnit('kg*m^2/s^2').dimensions));
  assert.equal(first('assume area = 9 m^2\nlet side = sqrt(area) as m\nprint "Side: {side}"'), 3);
});
test('deterministic property test: 4,000 conversion round trips over compatible units', () => {
  let seed = 1947;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const groups = [
    ['m', 'km', 'mi', 'cm', 'mm'],
    ['kg', 'g', 'mg', 't'],
    ['J', 'kJ', 'MJ', 'GJ', 'TJ', 'Wh', 'kWh'],
    ['s', 'min', 'h', 'day', 'year'],
    ['L', 'mL', 'm^3'],
    ['ratio', '%'],
  ];
  for (let i = 0; i < 4000; i++) {
    const group = groups[i % groups.length];
    assert.ok(group);
    const a = group[Math.floor(random() * group.length)],
      b = group[Math.floor(random() * group.length)];
    assert.ok(a);
    assert.ok(b);
    const value = (random() - 0.5) * 1e7;
    const roundTrip =
      (((value * getUnit(a).scale) / getUnit(b).scale) * getUnit(b).scale) / getUnit(a).scale;
    assert.ok(Math.abs(roundTrip - value) <= Math.max(1, Math.abs(value)) * 1e-12, `${a} → ${b}`);
  }
});
test('program size guard and compiler refuse malformed programs', () => {
  assert.equal(run(' '.repeat(30001)).diagnostics[0]?.title, 'Program too long');
  assert.throws(() => compile(parse('let x = 3')), /has no source/);
  assert.equal(run('assume x = 3\nprint "Plain text"').outputs[0]?.text, 'Plain text');
});
test('currency keeps two decimal places', () => {
  assert.equal(formatValue({ amount: 85.7, unit: '£' }), '£85.70');
});
test('round handles small exponential values and very large finite values', () => {
  assert.equal(first('assume x = 1.23e-7\nlet y = round(x, 8)\nprint "y: {y}"'), 0.00000012);
  assert.equal(first('assume x = 1e308\nlet y = round(x, 2)\nprint "y: {y}"'), 1e308);
});
test('deep syntax fails with a useful diagnostic instead of a stack overflow', () => {
  const result = run(`assume x = ${'('.repeat(150)}1${')'.repeat(150)}`);
  assert.equal(result.diagnostics[0]?.title, 'Calculation too deep');
});
test('interpolation diagnostics point at the original source after escaped characters', () => {
  const source = 'print "A\\n label: {missing}"';
  const diagnostic = run(source).diagnostics[0];
  assert.equal(diagnostic?.start, source.indexOf('missing'));
});
test('checker bounds expansion of nested function calls', () => {
  let source = 'fn f0(x) = x + x\n';
  for (let i = 1; i < 15; i++) source += `fn f${i}(x) = f${i - 1}(f${i - 1}(x))\n`;
  source += 'assume result = f14(1 kg)';
  assert.equal(run(source).diagnostics[0]?.title, 'Calculation too large');
});
test('conversion round trips pass through the actual interpreter with provenance intact', () => {
  const pairs = [
    ['mi', 'km'],
    ['kWh', 'MJ'],
    ['t', 'kg'],
    ['L', 'm^3'],
    ['day', 'h'],
    ['%', 'ratio'],
  ];
  for (let i = 1; i <= 100; i++)
    for (const [from, to] of pairs) {
      const result = run(
        `source test = "Conversion fixture"\nlet original = ${i * 7.123} ${from} @test\nlet there = original as ${to}\nlet back = there as ${from}\nprint "Back: {back}"`,
      );
      assert.deepEqual(result.diagnostics, []);
      assert.ok(Math.abs((result.outputs[0]?.value?.amount ?? Infinity) - i * 7.123) < 1e-9);
      assert.deepEqual(result.outputs[0]?.value?.dependencies, ['source:test']);
    }
});
test('checker reports the original mismatch without cascading unknown-name errors', () => {
  const result = run(
    'assume a = 1 kg\nassume b = 2 km\nlet bad = a + b\nlet later = bad * a\nprint "Broken: {later}"\nlet independent = a as h',
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.title),
    ['Units don’t add up', 'Units don’t add up'],
  );
});
test('unit exponent guards reject oversized exponents', () => {
  const result = run('assume x = 1 m^999999999999999999999999');
  assert.equal(result.diagnostics[0]?.title, 'Invalid exponent');
});
test('compiled function calls resolve functions independently of parameter names', () => {
  const source =
    'fn identity(x) = x\nfn apply(identity) = identity(identity)\nassume result = apply(2 kg)\nprint "Result: {result}"';
  assert.deepEqual(run(source).diagnostics, []);
  assert.equal(run(source).outputs[0]?.value?.amount, 2);
  assert.equal(compiled(source).outputs[0]?.value?.amount, 2);
});
test('JavaScript generation keeps hostile-looking source strings inert and names hygienic', () => {
  const source =
    'source __proto__ = "a \\"; throw Error(1); //"\nlet constructor = 2 kg @__proto__\nprint "Safe: {constructor}"';
  const result = run(source);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(compiled(source).outputs[0]?.text, 'Safe: 2 kg');
});
test('runtime graph limit prevents an oversized list from creating unlimited nodes', () => {
  const source = `assume xs = [${Array(6000).fill('1').join(',')}]`;
  assert.equal(run(source).diagnostics[0]?.title, 'Calculation too large');
});
test('call depth guard rejects a long chain of functions', () => {
  let source = 'fn f0(x) = x\n';
  for (let i = 1; i < 35; i++) source += `fn f${i}(x) = f${i - 1}(x)\n`;
  source += 'assume y = f34(1 kg)';
  assert.equal(run(source).diagnostics[0]?.title, 'Call limit reached');
});
test('deterministic malformed-input property test never throws or hangs', () => {
  let state = 371;
  const tokens = [
    'let',
    'assume',
    'source',
    'fn',
    'print',
    'x',
    '@s',
    '2',
    'kg',
    '(',
    ')',
    '[',
    ']',
    '=',
    '+',
    ',',
    '"a"',
    '\n',
  ];
  for (let i = 0; i < 500; i++) {
    let source = '';
    for (let j = 0; j < 25; j++) {
      state = (1664525 * state + 1013904223) >>> 0;
      source += `${tokens[state % tokens.length]} `;
    }
    assert.doesNotThrow(() => run(source), source);
  }
});
test('rational dimensions remain exact and fail explicitly when representation is exhausted', () => {
  let source = 'assume a0 = 1 m\n';
  for (let i = 1; i <= 54; i++) source += `let a${i} = sqrt(a${i - 1})\n`;
  assert.equal(run(source).diagnostics[0]?.title, 'Unit too complex');
});
test('underflowing unit scales fail explicitly', () => {
  assert.equal(
    run('assume a = 1 mg^32\nlet b = a * a').diagnostics[0]?.title,
    'Unit scale out of range',
  );
});
test('named SI derived units agree with base dimensions', () => {
  assert.ok(sameDimensions(getUnit('N').dimensions, getUnit('kg*m/s^2').dimensions));
  assert.ok(sameDimensions(getUnit('Pa').dimensions, getUnit('N/m^2').dimensions));
  assert.ok(sameDimensions(getUnit('V').dimensions, getUnit('W/A').dimensions));
  assert.ok(sameDimensions(getUnit('Ω').dimensions, getUnit('V/A').dimensions));
  assert.ok(sameDimensions(getUnit('Gy').dimensions, getUnit('J/kg').dimensions));
});
test('square roots simplify to a named unit when possible', () => {
  const result = run('assume area = 9 m^2\nlet side = sqrt(area)\nprint "Side: {side}"');
  assert.equal(result.outputs[0]?.text, 'Side: 3 m');
});
