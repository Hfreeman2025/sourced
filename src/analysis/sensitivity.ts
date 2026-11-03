import { run, type RunResult } from '../lang';
import type { InputLiteral } from './inputs';
import { probeInput } from './inputs';
export interface SensitivityRow {
  input: InputLiteral;
  low?: number;
  high?: number;
  lowValue: number;
  highValue: number;
  impact: number;
  lowError?: string;
  highError?: string;
}
export function reachableNodes(result: RunResult, outputIndex: number): Set<string> {
  const root = result.outputs[outputIndex]?.value?.node,
    byId = new Map(result.nodes.map((n) => [n.id, n]));
  const found = new Set<string>(),
    stack = root ? [root] : [];
  while (stack.length) {
    const id = stack.pop();
    if (!id || found.has(id)) continue;
    found.add(id);
    const node = byId.get(id);
    if (node) stack.push(...node.children);
  }
  return found;
}
export function contributingInputs(
  result: RunResult,
  outputIndex: number,
  inputs: InputLiteral[],
): InputLiteral[] {
  const reachable = reachableNodes(result, outputIndex);
  const leaves = new Set(
    result.nodes
      .filter((node) => reachable.has(node.id) && node.children.length === 0)
      .map((node) => node.span.start),
  );
  return inputs.filter((input) => input.role === 'value' && leaves.has(input.literal.start));
}
export function sensitivityRow(
  source: string,
  input: InputLiteral,
  result: RunResult,
  outputIndex: number,
  fraction = 0.1,
): SensitivityRow {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 2)
    throw new Error('Sensitivity fraction must be greater than 0 and at most 2.');
  const baseline = result.outputs[outputIndex]?.value;
  if (!baseline) throw new Error('Sensitivity needs a numeric result.');
  const delta = input.value === 0 ? input.step : Math.abs(input.value) * fraction;
  const lowValue = Number((input.value - delta).toPrecision(14)),
    highValue = Number((input.value + delta).toPrecision(14));
  const sample = (value: number): { change?: number; error?: string } => {
    const changed = run(probeInput(source, input, value));
    const quantity = changed.outputs[outputIndex]?.value;
    if (changed.diagnostics.length || !quantity)
      return {
        error: changed.diagnostics[0]?.message ?? 'This perturbation has no numeric output.',
      };
    const change = (quantity.amount * quantity.unit.scale) / baseline.unit.scale - baseline.amount;
    return Number.isFinite(change)
      ? { change }
      : { error: 'This perturbation is outside the finite range.' };
  };
  const low = sample(lowValue),
    high = sample(highValue);
  return {
    input,
    low: low.change,
    high: high.change,
    lowValue,
    highValue,
    lowError: low.error,
    highError: high.error,
    impact: Math.max(Math.abs(low.change ?? 0), Math.abs(high.change ?? 0)),
  };
}
