import type { RunResult } from '../lang';
import type { InputLiteral } from './inputs';
import { contributingInputs } from './sensitivity';

/** The inputs whose declared spread reaches a result, and who stands behind
 * each: cited sources by name, assumed spreads by the quantity they qualify. */
export function spreadsFor(result: RunResult, inputs: InputLiteral[], index: number) {
  const reaching = result.diagnostics.length
    ? []
    : contributingInputs(result, index, inputs).filter((input) => input.uncertainty);
  return {
    reaching,
    cited: [
      ...new Set(
        reaching.flatMap((input) =>
          input.uncertainty?.source ? [`@${input.uncertainty.source}`] : [],
        ),
      ),
    ],
    assumed: reaching.filter((input) => !input.uncertainty?.source).map((input) => input.label),
  };
}
