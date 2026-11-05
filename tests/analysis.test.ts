import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectInputs, replaceInput, scrubValue } from '../src/analysis/inputs';
import { contributingInputs, sensitivityRow } from '../src/analysis/sensitivity';
import { run } from '../src/lang';
import { examples } from '../src/examples';
const home = examples.find((example) => example.id === 'home')?.code ?? '';
test('scrubbing finds quantities without treating metadata or rounding precision as data', () => {
  const inputs = collectInputs(home);
  assert.deepEqual(
    inputs.map((x) => [x.label, x.value, x.source, x.assumption]),
    [
      ['usage', 284, 'bill', undefined],
      ['rate', 0.245, 'tariff', undefined],
      ['daily', 0.52, 'tariff', undefined],
      ['days', 31, undefined, 'days'],
    ],
  );
});
test('scrubbing changes only the numeric token, preserving units and source syntax', () => {
  const input = collectInputs(home)[0];
  assert.ok(input);
  const changed = replaceInput(home, input, 314);
  assert.equal(changed, home.replace('284 kWh', '314 kWh'));
  assert.equal(run(changed).outputs[0]?.value?.amount, 93.05);
  assert.deepEqual(
    run(changed).outputs[0]?.value?.dependencies,
    run(home).outputs[0]?.value?.dependencies,
  );
});
test('scrubbing signed, underscored, tiny and exponential numbers preserves valid syntax', () => {
  for (const [literal, value, unit] of [
    ['-1_200', -1190, 'kg'],
    ['0.000001', 0.000002, 'kg'],
    ['1e3', 1010, 'kg'],
    ['+2', -2, 'kg'],
  ] as const) {
    const source = `assume x = ${literal} ${unit}\nprint "x: {x}"`;
    const input = collectInputs(source)[0];
    assert.ok(input);
    const changed = replaceInput(source, input, value);
    assert.deepEqual(run(changed).diagnostics, []);
    assert.equal(run(changed).outputs[0]?.value?.amount, value);
  }
});
test('dragging is anchored to the original value; fine and coarse steps are deterministic', () => {
  const input = collectInputs(home)[0];
  assert.ok(input);
  assert.equal(scrubValue(input, 30), 314);
  assert.equal(scrubValue(input, 30, true), 284.3);
  assert.equal(scrubValue(input, 30, false, true), 584);
  assert.equal(scrubValue(input, 0), 284);
  assert.throws(() => replaceInput(home, input, Infinity), /finite/);
});
test('sensitivity recomputes actual finite changes including rounding', () => {
  const result = run(home);
  const inputs = contributingInputs(result, 0, collectInputs(home));
  assert.equal(inputs.length, 4);
  const usage = inputs.find((i) => i.label === 'usage');
  assert.ok(usage);
  const row = sensitivityRow(home, usage, result, 0);
  assert.equal(row.lowValue, 255.6);
  assert.equal(row.highValue, 312.4);
  assert.ok(Math.abs((row.low ?? Infinity) + 6.96) < 1e-9);
  assert.ok(Math.abs((row.high ?? Infinity) - 6.96) < 1e-9);
});
test('only inputs in the selected numeric result enter sensitivity', () => {
  const result = run(home);
  const inputs = collectInputs(home);
  assert.deepEqual(
    contributingInputs(result, 1, inputs).map((i) => i.label),
    ['usage', 'rate'],
  );
  assert.deepEqual(
    contributingInputs(result, 2, inputs).map((i) => i.label),
    ['daily', 'days'],
  );
});
test('shared source declarations do not merge distinct numerical inputs', () => {
  assert.equal(
    contributingInputs(run(home), 0, collectInputs(home)).filter((i) => i.source === 'tariff')
      .length,
    2,
  );
});
test('one literal reused in a function is perturbed at its definition once', () => {
  const source =
    'source factor = "Factor"\nfn f(x) = x * 2 ratio @factor\nassume a = 3 kg\nlet b = f(a) + f(a)\nprint "b: {b}"';
  const result = run(source);
  const inputs = contributingInputs(result, 0, collectInputs(source));
  assert.equal(inputs.length, 2);
  const factor = inputs.find((i) => i.source === 'factor');
  assert.ok(factor);
  const row = sensitivityRow(source, factor, result, 0);
  assert.ok(Math.abs((row.high ?? 0) - 1.2) < 1e-9);
});
test('zero input uses a labelled absolute step; invalid perturbations remain explicit', () => {
  const source = 'assume zero = 0 kg\nprint "x: {zero}"';
  const input = collectInputs(source)[0];
  assert.ok(input);
  const row = sensitivityRow(source, input, run(source), 0);
  assert.equal(row.lowValue, -1);
  assert.equal(row.highValue, 1);
  const bad = 'assume x = 1 kg\nlet y = sqrt(x)\nprint "y: {y}"';
  const x = collectInputs(bad)[0];
  assert.ok(x);
  const invalid = sensitivityRow(bad, x, run(bad), 0, 2);
  assert.equal(invalid.low, undefined);
  assert.match(invalid.lowError ?? '', /square root/);
  assert.ok(invalid.high !== undefined);
});
import { dependencyTokens } from '../src/analysis/trace';
import { diagramLayout } from '../src/analysis/diagram';
import { isRequest } from '../src/analysis/protocol';
import { compile, parse, createRuntime } from '../src/lang';
import { runInNewContext } from 'node:vm';
test('result tracing illuminates its source, bindings and function but excludes other inputs', () => {
  const trace = dependencyTokens(home, run(home), 1);
  const highlighted = (token: string) =>
    trace.some((span) => home.slice(span.start, span.end) === token);
  assert.ok(highlighted('usage'));
  assert.ok(highlighted('@'));
  assert.ok(highlighted('bill'));
  assert.ok(highlighted('rate'));
  assert.ok(highlighted('charge'));
  const daily = home.indexOf('let daily');
  assert.ok(!trace.some((span) => span.start >= daily && span.end <= home.indexOf('\n', daily)));
  const days = home.indexOf('assume days');
  assert.ok(!trace.some((span) => span.start >= days && span.end <= home.indexOf('\n', days)));
  const fn = home.indexOf('fn charge');
  assert.ok(trace.some((span) => span.start === fn));
});
test('diagram is a connected technical DAG with unique nodes and no column overlaps', () => {
  for (const example of examples) {
    const diagram = diagramLayout(run(example.code), 0);
    assert.ok(diagram.root);
    const nodes = new Map(diagram.nodes.map((n) => [n.node.id, n]));
    assert.equal(nodes.size, diagram.nodes.length);
    for (const edge of diagram.edges) {
      const a = nodes.get(edge.from),
        b = nodes.get(edge.to);
      assert.ok(a && b);
      assert.ok(diagram.vertical ? a.y < b.y : a.x < b.x);
    }
    for (const a of diagram.nodes)
      for (const b of diagram.nodes)
        if (a !== b)
          assert.ok(
            a.x + a.width <= b.x - 14 || b.x + b.width <= a.x - 14 || Math.abs(a.y - b.y) >= 70,
            'Annotation footprints must not overlap',
          );
  }
});
test('responsive diagrams use the available width and reserve tall readable layouts', () => {
  for (const width of [343, 587])
    for (const example of examples) {
      const result = run(example.code);
      for (let output = 0; output < result.outputs.length; output++) {
        const diagram = diagramLayout(result, output, width);
        assert.equal(diagram.width, width);
        for (const item of diagram.nodes) {
          assert.ok(item.x - 14 >= 0 && item.x + item.width <= width);
          assert.ok(item.y - 28 >= 0 && item.y + 42 <= diagram.height);
        }
        if (example.id !== 'commute') assert.equal(diagram.large, false);
      }
    }
});
test('diagram retains an assumption that adds provenance to a sourced number', () => {
  const source = 'source s = "Example"\nassume x = 2 kg @s\nprint "x: {x}"';
  const diagram = diagramLayout(run(source), 0);
  assert.ok(diagram.nodes.some((n) => n.node.kind === 'source'));
  assert.ok(diagram.nodes.some((n) => n.node.kind === 'assumption'));
});
test('the commute derivation keeps its vertical operations and annotations on one spine', () => {
  const commute = examples.find((example) => example.id === 'commute');
  assert.ok(commute);
  const diagram = diagramLayout(run(commute.code), 0);
  assert.equal(diagram.vertical, true);
  assert.equal(new Set(diagram.nodes.filter((n) => n.level > 0).map((n) => n.x)).size, 1);
});
test('a thousand-step derivation lays out without recursive stack growth', () => {
  let source = 'assume one = 1 kg\nassume x0 = 0 kg\n';
  for (let i = 1; i <= 1000; i++) source += `let x${i} = x${i - 1} + one\n`;
  source += 'print "x: {x1000}"';
  const result = run(source);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.outputs[0]?.value?.amount, 1000);
  assert.ok(diagramLayout(result, 0).nodes.length >= 1002);
});
test('sensitivity signs follow real nonlinear results, not an invented symmetric range', () => {
  const source = 'assume x = 10\nassume one = 1\nlet y = one / x\nprint "y: {y}"';
  const input = collectInputs(source)[0];
  assert.ok(input);
  const row = sensitivityRow(source, input, run(source), 0);
  assert.ok((row.low ?? 0) > 0);
  assert.ok((row.high ?? 0) < 0);
  assert.notEqual(Math.abs(row.low ?? 0), Math.abs(row.high ?? 0));
});
test('worker request validation rejects missing, invalid and nonfinite fields', () => {
  for (const input of [
    null,
    {},
    { id: 1, source: '', outputIndex: 0, fraction: 0 },
    { id: 1, source: 3, outputIndex: 0, fraction: 0.1 },
    { id: 1, source: '', outputIndex: -1, fraction: 0.1 },
    { id: 1, source: '', outputIndex: 0, fraction: Infinity },
  ])
    assert.equal(isRequest(input), false);
  assert.equal(isRequest({ id: 1, source: home, outputIndex: 0, fraction: 0.1 }), true);
});
test('scrubbed programs still agree with compiled JavaScript in every example', () => {
  for (const example of examples) {
    for (const input of collectInputs(example.code)) {
      const source = replaceInput(example.code, input, input.value * 1.1),
        interpreted = run(source);
      if (interpreted.diagnostics.length) {
        // Scrubbing past a declared interval is an explicit error in both backends.
        assert.match(
          interpreted.diagnostics[0]?.title ?? '',
          /^The range (excludes the value|is back to front)$/,
        );
        assert.throws(() => compile(parse(source)), /doesn’t contain|no width/);
        continue;
      }
      const compiled = runInNewContext(
        `(function(rt){${compile(parse(source))}})`,
        {},
        { timeout: 1000 },
      )(createRuntime());
      assert.deepEqual(
        JSON.parse(JSON.stringify(compiled.outputs)),
        JSON.parse(JSON.stringify(interpreted.outputs)),
      );
    }
  }
});
test('manual quantity edits retain the requested representable precision', () => {
  const source = 'assume x = 0.1 kg\nprint "x: {x}"',
    input = collectInputs(source)[0];
  assert.ok(input);
  const value = 0.1234567890123456;
  assert.equal(run(replaceInput(source, input, value)).outputs[0]?.value?.amount, value);
});
test('very small and large quantities remain readable nonzero values', () => {
  const tiny = run('assume x = 0.0000001 kg\nprint "x: {x}"');
  assert.equal(tiny.outputs[0]?.text, 'x: 1e-7 kg');
  const huge = run('assume x = 1e15 kg\nprint "x: {x}"');
  assert.equal(huge.outputs[0]?.text, 'x: 1e+15 kg');
});
test('currency display preserves sub-penny quantities instead of implying zero', () => {
  assert.equal(run('assume x = 0.001 £\nprint "x: {x}"').outputs[0]?.text, 'x: £0.001');
});
import { canEvaluateInFrame } from '../src/analysis/frame-budget';
test('all bundled examples fit the direct-manipulation evaluation budget', () => {
  for (const example of examples) assert.equal(canEvaluateInFrame(example.code), true, example.id);
});
test('large or deeply composed programs stay in the worker', () => {
  assert.equal(canEvaluateInFrame(' '.repeat(1001)), false);
  const many = Array.from({ length: 12 }, (_, i) => `fn f${i}(x) = x`).join('\n');
  assert.equal(canEvaluateInFrame(many), false);
  assert.equal(canEvaluateInFrame(`assume x = ${Array(100).fill('1').join('+')}`), false);
});
