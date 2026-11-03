import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { compile, createRuntime, parse, run } from '../src/lang';
import { formatDiagnostic } from '../src/lang/lexer';
import { roundAmount, type Evaluation } from '../src/lang/runtime';
import type { Expr } from '../src/lang/types';
import { collectInputs, probeInput, replaceInput } from '../src/analysis/inputs';
import { evaluateColumns, roundColumn } from '../src/analysis/columns';
import {
  MONTE_CARLO_RUNS,
  PREVIEW_RUNS,
  propagate,
  sampleInputs,
  varianceShares,
} from '../src/analysis/montecarlo';
import { contributingInputs, sensitivityRow } from '../src/analysis/sensitivity';
import { examples } from '../src/examples';
import { fillUniform, stream } from '../src/stats/random';

const example = (id: string) => examples.find((item) => item.id === id)?.code ?? '';
const firstNumber = (source: string) => {
  const statement = parse(source).statements.find((s) => s.kind === 'binding');
  assert.ok(statement?.kind === 'binding' && statement.value.kind === 'number');
  return statement.value;
};
const compiled = (source: string): Evaluation =>
  runInNewContext(`(function(rt) { ${compile(parse(source))} })`, {}, { timeout: 1000 })(
    createRuntime(),
  );

test('every spread form parses with exact spans and its provenance', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['±5%', 'plusminus', { width: { value: 5, unit: '%' } }],
    ['+-2 km', 'plusminus', { width: { value: 2, unit: 'km' } }],
    ['0.72..0.775', 'range', { low: { value: 0.72, unit: '' }, high: { value: 0.775, unit: '' } }],
    ['95% 67_500..73_000', 'range', { coverage: { value: 95, unit: '%' } }],
    ['-1..3', 'range', { low: { value: -1, unit: '' } }],
    ['normal(12%)', 'normal', { sd: { value: 12, unit: '%' } }],
    ['lognormal(1.2)', 'lognormal', { factor: { value: 1.2, unit: '' } }],
    ['triangular(60, 100)', 'triangular', { high: { value: 100, unit: '' } }],
    ['uniform(60 kg, 0.1 t)', 'range', { named: true, high: { value: 0.1, unit: 't' } }],
  ];
  for (const [spread, kind, fields] of cases) {
    const source = `source s = "S"\nlet x = 70 kg @s ~ ${spread} @s`;
    const literal = firstNumber(source);
    assert.equal(literal.uncertainty?.spread.kind, kind, spread);
    assert.equal(literal.uncertainty?.source, 's');
    const spreadNode = literal.uncertainty?.spread as unknown as Record<string, unknown>;
    for (const [key, expected] of Object.entries(fields)) {
      const actual = spreadNode[key];
      if (typeof expected === 'object' && expected)
        for (const [field, value] of Object.entries(expected))
          assert.equal((actual as Record<string, unknown>)[field], value, `${spread} ${key}.${field}`);
      else assert.equal(actual, expected);
    }
    const at = source.indexOf('~');
    assert.equal(literal.uncertainty?.start, at);
    assert.equal(source.slice(literal.uncertainty?.spread.start, literal.uncertainty?.spread.end), spread);
    assert.equal(literal.end, source.length, 'the literal span includes its uncertainty');
  }
  const assumed = firstNumber('let x = 70 kg @s ~ ±5% assumed');
  assert.equal(assumed.uncertainty?.source, undefined);
  assert.equal(assumed.uncertainty?.provenance.start, 'let x = 70 kg @s ~ ±5% '.length);
});

test('uncertainty errors explain the mistake at its exact span', () => {
  const diagnostics = [
    ['assume t = 70 kg ~ 80..100 assumed', 'The range excludes the value', '80..100'],
    ['assume t = 70 kg ~ 100..60 assumed', 'The range is back to front', '100..60'],
    ['assume t = 70 kg ~ ±5 kWh assumed', 'Units don’t match', '5 kWh'],
    ['assume t = 70 kg ~ ±5%', 'Uncertainty needs a source', ''],
    ['assume t = 70 kg ~ ±5% @nowhere', 'Unknown source', '@nowhere'],
    ['assume t = 70 kg ~ lognormal(0.9) assumed', 'A factor above 1 belongs here', '0.9'],
    ['assume t = 0 kg ~ lognormal(1.2) assumed', 'Lognormal needs a positive value', 'lognormal(1.2)'],
    ['assume t = 0 kg ~ ±5% assumed', 'A percentage of zero', '5%'],
    ['assume t = 70 kg ~ ±0 kg assumed', 'The spread must be positive', '0 kg'],
    ['assume t = 70 kg ~ 40% 60..80 assumed', 'Coverage out of range', '40%'],
    ['assume t = 70 kg ~ banana assumed', 'Unknown uncertainty', 'banana'],
    ['assume t = 70 kg ~ 60 assumed', 'Unfinished range', 'assumed'],
    ['assume t = 70 kg\nprint "t: {round(t, 2 ~ ±1 assumed)}"', 'Invalid rounding precision', '~ ±1 assumed'],
  ] as const;
  for (const [source, title, span] of diagnostics) {
    const result = run(source);
    const issue = result.diagnostics[0];
    assert.equal(issue?.title, title, source);
    if (span) assert.equal(source.slice(issue.start, issue.end), span, source);
    assert.deepEqual(result.outputs, [], 'no stale result survives an invalid spread');
  }
  assert.equal(
    formatDiagnostic('assume t = 70 kg ~ 80..100 assumed', run('assume t = 70 kg ~ 80..100 assumed').diagnostics[0] ?? { start: 0, end: 0, title: '', message: '', hint: '' }),
    'The range excludes the value at 1:20\n1 | assume t = 70 kg ~ 80..100 assumed\n                       ^^^^^^^\n80..100 kg doesn’t contain 70 kg.\nWiden the range, or move the value inside it.',
  );
});

test('a cited spread needs a declared source; an assumed spread on a cited value is allowed', () => {
  assert.equal(run('source a = "A"\nlet x = 2 kg @a ~ ±5% @b').diagnostics[0]?.title, 'Unknown source');
  const mixed = run('source a = "A"\nlet x = 2 kg @a ~ ±5% assumed\nprint "x: {x}"');
  assert.deepEqual(mixed.diagnostics, []);
  const node = mixed.nodes.find((n) => n.uncertainty);
  assert.equal(node?.uncertainty?.source, undefined);
  assert.deepEqual(node?.dependencies, ['source:a']);
});

test('the interpreter and compiled JavaScript agree on uncertain lineage in every example', () => {
  for (const item of examples) {
    const interpreted = run(item.code);
    assert.deepEqual(interpreted.diagnostics, [], item.id);
    assert.deepEqual(
      JSON.parse(JSON.stringify(compiled(item.code))),
      JSON.parse(JSON.stringify({ ...interpreted, diagnostics: undefined })),
      item.id,
    );
  }
  const commute = run(example('commute'));
  const emission = commute.nodes.find((n) => n.label === '@ipcc');
  assert.equal(emission?.uncertainty?.distribution.kind, 'split-normal');
  assert.equal(emission?.uncertainty?.source, 'ipcc');
});

test('spread literals are draggable but never perturbed as data inputs', () => {
  const source = example('commute'),
    inputs = collectInputs(source);
  const spreads = inputs.filter((input) => input.role === 'spread');
  assert.deepEqual(
    spreads.map((input) => [input.label, input.raw, input.owner]),
    [
      ['emission low', '67500', 'emission:0'],
      ['emission high', '73000', 'emission:0'],
      ['calorific low', '42.5', 'calorific:0'],
      ['calorific high', '44.8', 'calorific:0'],
      ['density spread', '0.025', 'density:0'],
      ['consumption sd', '12', 'consumption:0'],
      ['daily spread', '2', 'daily:0'],
    ],
  );
  const high = spreads[1];
  assert.ok(high);
  const widened = replaceInput(source, high, 75_000);
  assert.match(widened, /95% 67500\.\.75000 @ipcc/);
  assert.deepEqual(run(widened).diagnostics, []);
  assert.equal(contributingInputs(run(source), 0, inputs).length, 6);
  assert.ok(contributingInputs(run(source), 0, inputs).every((input) => input.role === 'value'));
  // Two literals in one binding keep distinct, readable labels.
  const pair = collectInputs('assume x = sum([1 kg ~ ±1 kg assumed, 2 kg])').filter(
    (input) => input.role === 'value',
  );
  assert.deepEqual(pair.map((input) => input.label), ['x', 'x [2]']);
});

test('fast column rounding equals the interpreter rounding, including ties', () => {
  const next = stream(4, 'rounding');
  const values = [1.005, -2.345, 2.5, -2.5, 0.125, 1e-7, 123456.785, -0.0049, 0.5, 1e15 + 0.5];
  for (let i = 0; i < 20_000; i++) {
    const magnitude = 10 ** (((next() % 1600) - 800) / 100);
    values.push(((next() / 4294967296) * 2 - 1) * magnitude);
    values.push(Math.round((next() / 4294967296) * 1e6) / 1000 + 0.0005);
  }
  for (const places of [0, 1, 2, 3, 6, 8]) {
    const fast = roundColumn(Float64Array.from(values), places);
    values.forEach((value, i) => {
      const exact = roundAmount(value, places);
      assert.ok(Object.is(fast[i], exact) || (fast[i] === 0 && exact === 0), `${value} at ${places}`);
    });
  }
});

/** Replaces each literal with a sampled value; strips spreads so that values
 * outside a cited interval stay valid for the scalar interpreter. */
const stripSpreads = (source: string) => {
  const spans: { start: number; end: number }[] = [];
  const visit = (expr: Expr): void => {
    if (expr.kind === 'number' && expr.uncertainty) spans.push(expr.uncertainty);
    if (expr.kind === 'binary') [expr.left, expr.right].forEach(visit);
    if (expr.kind === 'unary' || expr.kind === 'convert') visit(expr.value);
    if (expr.kind === 'list') expr.items.forEach(visit);
    if (expr.kind === 'call') expr.args.forEach(visit);
  };
  for (const statement of parse(source).statements) {
    if (statement.kind === 'binding') visit(statement.value);
    if (statement.kind === 'function') visit(statement.body);
    if (statement.kind === 'print')
      for (const part of statement.parts) if ('expr' in part) visit(part.expr);
  }
  return spans
    .sort((a, b) => b.start - a.start)
    .reduce((text, span) => text.slice(0, span.start).trimEnd() + text.slice(span.end), source);
};

test('the column evaluator reproduces the scalar interpreter bit for bit on every example', () => {
  for (const item of examples) {
    const source = stripSpreads(item.code),
      program = parse(source);
    const inputs = collectInputs(source).filter((input) => input.role === 'value');
    const runs = 40;
    const columns = new Map<number, Float64Array>();
    inputs.forEach((input) => {
      const u = fillUniform(new Float64Array(runs), 9, input.id);
      // Draw each run's value within ±30% of the literal; keep run 0 central.
      columns.set(input.literal.start, u.map((x, j) => (j ? input.value * (0.7 + 0.6 * x) : input.value)));
    });
    // Signed literals: the column holds the unsigned literal; unary minus applies.
    for (const input of inputs)
      if (input.value < 0) {
        const column = columns.get(input.literal.start);
        if (column) columns.set(input.literal.start, column.map((x) => -x));
      }
    const evaluation = evaluateColumns(program, columns, runs);
    for (let j = 0; j < runs; j++) {
      let changed = source;
      for (const input of [...inputs].reverse())
        changed = replaceInput(changed, input, (columns.get(input.literal.start)?.[j] ?? 0) * Math.sign(input.value || 1));
      const scalar = run(changed);
      assert.deepEqual(scalar.diagnostics, [], `${item.id} run ${j}`);
      scalar.outputs.forEach((output, i) => {
        const column = evaluation.outputs[i];
        const lane = column?.lane;
        const value = typeof lane === 'number' ? lane : lane?.[j];
        assert.ok(Object.is(value, output.value?.amount), `${item.id} output ${i} run ${j}: ${value} vs ${output.value?.amount}`);
        assert.equal(column?.unit.symbol, output.value?.unit.symbol);
      });
    }
  }
});

test('analytic: a sum of normals in mixed units keeps its unit and its quantiles', () => {
  const source =
    'assume a = 10 km ~ normal(1 km) assumed\nassume b = 5 mi ~ normal(0.5 mi) assumed\nlet total = a + b\nprint "Total: {total}"';
  const result = run(source);
  const { outputs } = propagate(source, result, collectInputs(source));
  const distribution = outputs[0];
  assert.equal(distribution?.unit, 'km');
  const mean = 10 + 5 * 1.609344,
    sd = Math.hypot(1, 0.5 * 1.609344),
    z = 1.6448536269514722;
  const summary = distribution?.summary;
  assert.ok(summary);
  // 100,000 runs: quantile standard errors are ≈ 0.009 km (P5, P95) and 0.005 km (P50).
  assert.ok(Math.abs(summary.p50 - mean) < 0.02, `P50 ${summary.p50}`);
  assert.ok(Math.abs(summary.p5 - (mean - z * sd)) < 0.04, `P5 ${summary.p5}`);
  assert.ok(Math.abs(summary.p95 - (mean + z * sd)) < 0.04, `P95 ${summary.p95}`);
  assert.ok(Math.abs(summary.sd / sd - 1) < 0.01);
});

test('analytic: a product of lognormals is lognormal with added log-variances', () => {
  const source =
    'assume energy = 1000 kWh ~ lognormal(1.2) assumed\nassume factor = 0.2 kg/kWh ~ lognormal(1.5) assumed\nlet carbon = energy * factor\nprint "Carbon: {carbon}"';
  const distribution = propagate(source, run(source), collectInputs(source)).outputs[0];
  assert.equal(distribution?.unit, 'kg');
  const sigma = Math.hypot(Math.log(1.2), Math.log(1.5)),
    z = 1.6448536269514722;
  const summary = distribution?.summary;
  assert.ok(summary);
  for (const [actual, expected] of [
    [summary.p5, 200 * Math.exp(-z * sigma)],
    [summary.p50, 200],
    [summary.p95, 200 * Math.exp(z * sigma)],
    [summary.mean, 200 * Math.exp(sigma ** 2 / 2)],
  ] as const)
    assert.ok(Math.abs(actual / expected - 1) < 0.01, `${actual} vs ${expected}`);
});

test('analytic: Sobol indices through the language expose a product interaction', () => {
  const source =
    'assume x1 = 1 kg ~ normal(1 kg) assumed\nassume x2 = 2 m ~ normal(0.5 m) assumed\nlet y = x1 * x2\nprint "y: {y}"';
  const shares = varianceShares(source, run(source), collectInputs(source), 0);
  const [x1, x2] = shares.rows;
  assert.ok(x1 && x2);
  assert.ok(Math.abs(x1.first - 4 / 4.5) < 0.03 && Math.abs(x1.total - 4.25 / 4.5) < 0.03);
  assert.ok(Math.abs(x2.first - 0.25 / 4.5) < 0.03 && Math.abs(x2.total - 0.5 / 4.5) < 0.03);
  assert.equal(shares.evaluations, 16_384 * 4);
});

test('one literal is one random variable, even when a function uses it twice', () => {
  const source =
    'source s = "Synthetic"\nfn scaled(x) = x * 2 ratio @s ~ ±50% assumed\nassume a = 1 kg\nlet gap = scaled(a) - scaled(a)\nprint "Gap: {gap}"\nprint "Scaled: {scaled(a)}"';
  const { outputs } = propagate(source, run(source), collectInputs(source), 20_000);
  assert.equal(outputs[0]?.exact, false);
  assert.equal(outputs[0]?.summary?.min, 0);
  assert.equal(outputs[0]?.summary?.max, 0);
  assert.ok((outputs[1]?.summary?.min ?? 0) >= 1 && (outputs[1]?.summary?.max ?? 9) <= 3);
});

test('failed runs are counted and excluded, never folded into the distribution', () => {
  const source = 'assume area = 1 m^2 ~ -1..3 assumed\nlet side = sqrt(area)\nprint "Side: {side}"';
  const distribution = propagate(source, run(source), collectInputs(source)).outputs[0];
  // A quarter of the uniform range is negative. Binomial standard error ≈ 0.0014.
  assert.ok(Math.abs((distribution?.undefinedRuns ?? 0) / MONTE_CARLO_RUNS - 0.25) < 0.006);
  assert.ok((distribution?.summary?.min ?? -1) >= 0);
  assert.equal(distribution?.summary?.count, MONTE_CARLO_RUNS - (distribution?.undefinedRuns ?? 0));
});

test('seeds are deterministic; the scrub preview is a prefix of the refined run', () => {
  const source = example('commute'),
    result = run(source),
    inputs = collectInputs(source);
  const a = propagate(source, result, inputs, 20_000, 7),
    b = propagate(source, result, inputs, 20_000, 7),
    c = propagate(source, result, inputs, 20_000, 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.outputs[0]?.summary, c.outputs[0]?.summary);
  assert.ok(Math.abs((a.outputs[0]?.summary?.p50 ?? 0) - (c.outputs[0]?.summary?.p50 ?? 0)) < 0.5);
  const preview = sampleInputs(inputs, PREVIEW_RUNS, 1),
    full = sampleInputs(inputs, MONTE_CARLO_RUNS, 1);
  for (const [key, column] of preview) assert.deepEqual(column, full.get(key)?.subarray(0, PREVIEW_RUNS));
});

test('dragging one quantity leaves every other quantity’s random numbers unchanged', () => {
  const source = example('commute'),
    inputs = collectInputs(source);
  const consumption = inputs.find((input) => input.label === 'consumption');
  assert.ok(consumption);
  const dragged = replaceInput(source, consumption, 0.07),
    after = collectInputs(dragged);
  const before = sampleInputs(inputs, 1000, 1),
    moved = sampleInputs(after, 1000, 1);
  const emission = inputs.find((input) => input.label === 'emission');
  assert.ok(emission);
  assert.deepEqual(before.get(emission.literal.start), moved.get(emission.literal.start));
  // The dragged quantity reuses its uniforms: every draw scales by 0.07 / 0.065.
  const was = before.get(consumption.literal.start)?.[5] ?? 0,
    now = moved.get(consumption.literal.start)?.[5] ?? 0;
  assert.ok(Math.abs(now / was - 0.07 / 0.065) < 1e-12);
});

test('example findings: the commute is dominated by assumed consumption, not the cited factors', () => {
  const source = example('commute'),
    result = run(source),
    inputs = collectInputs(source);
  const distribution = propagate(source, result, inputs).outputs[0];
  const summary = distribution?.summary;
  assert.ok(summary && distribution);
  assert.equal(distribution.central, 70.88);
  assert.ok(summary.p5 < 70.88 && 70.88 < summary.p95);
  const shares = varianceShares(source, result, inputs, 0);
  const byLabel = new Map(
    shares.rows.map((row) => [inputs.find((input) => input.id === row.inputId)?.label, row]),
  );
  assert.ok((byLabel.get('consumption')?.total ?? 0) > 0.7);
  assert.ok((byLabel.get('emission')?.total ?? 1) < 0.05);
  assert.equal(byLabel.has('workdays'), false, 'a fixed input has no variance to share');
  // Solar: the mean payback exceeds the payback at mean inputs (Jensen's inequality).
  const solar = example('solar'),
    payback = propagate(solar, run(solar), collectInputs(solar)).outputs[0];
  assert.ok((payback?.summary?.mean ?? 0) > (payback?.central ?? Infinity));
  for (const id of ['home', 'recipe']) {
    const code = example(id);
    assert.equal(propagate(code, run(code), collectInputs(code)).outputs[0]?.exact, true, id);
  }
});

test('the tornado probes a value without its own spread, so cited intervals never block it', () => {
  const source = example('commute'),
    result = run(source),
    inputs = collectInputs(source);
  const emission = inputs.find((input) => input.label === 'emission');
  assert.ok(emission);
  const probe = probeInput(source, emission, 76_230);
  assert.match(probe, /let emission = 76230 kg\/TJ @ipcc\n/);
  assert.match(probe, /95% 42\.5\.\.44\.8 @heat/, 'other spreads are untouched');
  for (const input of contributingInputs(result, 0, inputs)) {
    const row = sensitivityRow(source, input, result, 0, 0.2);
    assert.equal(row.lowError, undefined, input.label);
    assert.equal(row.highError, undefined, input.label);
    assert.ok(row.impact > 0, input.label);
  }
});

test('review: each output excludes only the runs where its own calculation fails', () => {
  const source = 'assume x = 1 ~ normal(1) assumed\nprint "x: {x}"\nprint "root: {sqrt(x)}"';
  const [x, root] = propagate(source, run(source), collectInputs(source)).outputs;
  assert.equal(x?.undefinedRuns, 0, 'x itself never fails');
  assert.ok(Math.abs((x?.summary?.mean ?? 0) - 1) < 0.01, `x keeps its stated mean: ${x?.summary?.mean}`);
  // P(x < 0) = Φ(−1) = 0.1587; binomial standard error ≈ 0.0012.
  assert.ok(Math.abs((root?.undefinedRuns ?? 0) / MONTE_CARLO_RUNS - 0.1587) < 0.005);
});

test('review: a unit written right before .. is a unit, not part of a dotted name', () => {
  for (const source of [
    'assume d = 5 km ~ 4 km..6 km assumed\nprint "d: {d}"',
    'assume f = 0.5 kg/kWh ~ 0.4 kg/kWh..0.6 kg/kWh assumed\nprint "f: {f}"',
  ]) {
    const result = run(source);
    assert.deepEqual(result.diagnostics, [], source);
    assert.equal(result.nodes[0]?.uncertainty?.distribution.kind, 'uniform');
  }
  assert.equal(
    run('source invoice.march = "A"\nlet x = 2 kg @invoice.march\nprint "x: {x}"').outputs[0]?.text,
    'x: 2 kg',
  );
});

test('review: a spread on a negative literal describes the signed quantity', () => {
  const valid = run('assume t = -5 kg ~ -6..-4 assumed\nprint "t: {t}"');
  assert.deepEqual(valid.diagnostics, []);
  assert.deepEqual(valid.nodes[0]?.uncertainty?.distribution, { kind: 'uniform', low: -6, high: -4 });
  assert.equal(
    run('assume t = -5 kg ~ 4..6 assumed\nprint "t: {t}"').diagnostics[0]?.title,
    'The range excludes the value',
  );
  const signed = 'assume t = -5 kg ~ -6..-4 assumed\nprint "t: {t}"',
    input = collectInputs(signed)[0];
  assert.equal(input?.raw, '-5');
  assert.ok(input);
  assert.match(replaceInput(signed, input, -4.5), /assume t = -4\.5 kg ~ -6\.\.-4/);
  // A sign before a parenthesis is not part of the number's text.
  const bracketed = 'assume t = -(5 kg)\nprint "t: {t}"',
    inner = collectInputs(bracketed)[0];
  assert.ok(inner);
  assert.equal(replaceInput(bracketed, inner, 6), 'assume t = -(6 kg)\nprint "t: {t}"');
});

test('review: variance shares work at any magnitude, not just near 1', () => {
  const source =
    'assume c = 3e-13 kg ~ ±10% assumed\nassume d = 2e-13 kg ~ ±30% assumed\nlet total = c + d\nprint "Total: {total}"';
  const shares = varianceShares(source, run(source), collectInputs(source), 0);
  assert.equal(shares.varies, true);
  // Uniform half-widths 0.3e-13 and 0.6e-13: variances in the ratio 1 : 4.
  assert.ok(Math.abs((shares.rows[0]?.first ?? 0) - 0.2) < 0.03);
  assert.ok(Math.abs((shares.rows[1]?.first ?? 0) - 0.8) < 0.03);
});

test('review: an overflowing sampled input is an undefined run, not an infinite mean', () => {
  const source = 'assume a = 1e308 kg ~ normal(1e308 kg) assumed\nprint "a: {a}"';
  const [a] = propagate(source, run(source), collectInputs(source), 20_000).outputs;
  assert.ok((a?.undefinedRuns ?? 0) > 0);
  assert.ok(Number.isFinite(a?.summary?.mean ?? Number.NaN));
  assert.ok(Number.isFinite(a?.summary?.max ?? Number.NaN));
});
