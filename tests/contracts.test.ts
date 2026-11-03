import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/lang/index';
test('a sourced calculation returns its concrete converted answer', () => {
  const result = run(
    'source bill = "Illustrative bill"\nlet energy = 14_200 kWh @bill\nassume tariff = 0.25 £/kWh\nlet cost = energy * tariff\nprint "Bill: {cost}"',
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.outputs[0]?.text, 'Bill: £3,550.00');
});
test('bare numbers are refused outside an explicit assumption', () => {
  const result = run('let count = 14200');
  assert.equal(result.diagnostics[0]?.title, 'Every number needs a source');
});
