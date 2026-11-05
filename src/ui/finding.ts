import type { InputLiteral } from '../analysis/inputs';
import type { VarianceShares } from '../analysis/montecarlo';
import type { SensitivityRow } from '../analysis/sensitivity';
import { percent } from './sensitivity';

/** The sentence above the sensitivity table, written by rule from the numbers on
 * screen: which input's uncertainty matters most, how the variance splits between
 * cited and assumed spreads (or how the tornado disagrees), and any interactions. */
export function shareFinding(
  shares: VarianceShares,
  nudges: SensitivityRow[],
  inputs: InputLiteral[],
  variation: string,
): string | undefined {
  if (!shares.varies || !shares.rows.length) return undefined;
  const label = (id: string) => inputs.find((input) => input.id === id);
  const top = [...shares.rows].sort((a, b) => b.first - a.first)[0];
  if (!top) return undefined;
  let cited = 0,
    assumed = 0,
    alone = 0;
  for (const row of shares.rows) {
    alone += Math.max(0, row.first);
    if (label(row.inputId)?.uncertainty?.source) cited += Math.max(0, row.first);
    else assumed += Math.max(0, row.first);
  }
  const parts = [
    `Knowing ${label(top.inputId)?.label ?? 'the top input'} exactly would remove about ${percent(top.first)} of the variance.`,
  ];
  const nudged = nudges[0];
  const largest = nudged?.impact ?? 0;
  if (cited > 0 && assumed > 0)
    parts.push(`Cited spreads account for ${percent(cited)}, assumed spreads ${percent(assumed)}.`);
  else if (nudged && !nudged.input.uncertainty && largest > 0)
    parts.push(
      `A ${variation} nudge to ${nudged.input.label} moves the result most, but it has no declared uncertainty.`,
    );
  else if (
    nudges.length > 1 &&
    nudges.every((row) => Math.abs(row.impact - largest) <= largest * 0.01)
  )
    parts.push(`Every ${variation} nudge moves the result equally; only the uncertainty differs.`);
  const interaction = 1 - alone;
  if (interaction >= 0.015) parts.push(`Interactions: ${percent(interaction)}.`);
  return parts.join(' ');
}
