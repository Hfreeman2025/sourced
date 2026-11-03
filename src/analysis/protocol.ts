import type { RunResult } from '../lang';
import type { Span } from '../lang/types';
import type { InputLiteral } from './inputs';
import type { Propagation, VarianceShares } from './montecarlo';
import type { SensitivityRow } from './sensitivity';
export interface AnalysisRequest {
  id: number;
  source: string;
  outputIndex: number;
  fraction: number;
  /** Monte Carlo seed; the same seed always gives the same distribution. */
  seed?: number;
}
export type AnalysisResponse =
  | { phase: 'result'; id: number; result: RunResult; inputs: InputLiteral[]; traces: Span[][] }
  | { phase: 'sensitivity'; id: number; rows: SensitivityRow[]; total: number }
  | { phase: 'progress'; id: number; completed: number; total: number }
  | {
      phase: 'distribution';
      id: number;
      refined: boolean;
      propagation: Propagation;
      elapsedMs: number;
    }
  | { phase: 'shares'; id: number; shares: VarianceShares; elapsedMs: number }
  | { phase: 'error'; id: number; message: string };
export function isRequest(value: unknown): value is AnalysisRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value &&
    Number.isSafeInteger(value.id) &&
    'source' in value &&
    typeof value.source === 'string' &&
    'outputIndex' in value &&
    typeof value.outputIndex === 'number' &&
    Number.isSafeInteger(value.outputIndex) &&
    value.outputIndex >= 0 &&
    'fraction' in value &&
    typeof value.fraction === 'number' &&
    value.fraction > 0 &&
    value.fraction <= 2 &&
    (!('seed' in value) ||
      value.seed === undefined ||
      (typeof value.seed === 'number' &&
        Number.isSafeInteger(value.seed) &&
        value.seed >= 0 &&
        value.seed <= 0xffffffff))
  );
}
