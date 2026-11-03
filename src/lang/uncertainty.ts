import type { Distribution } from '../stats/distributions';
import { inverseNormal } from '../stats/normal';
import { fail, type Amount, type Uncertainty } from './types';
import { getUnit, sameDimensions } from './units';

const plain = (value: number) => Number(value.toPrecision(12)).toLocaleString('en-GB');

/** Resolves an uncertainty clause against its literal, in the literal's own unit.
 *
 * - `±w` and `low..high` state limits only, so they are uniform (GUM, JCGM
 *   100:2008 §4.3.7: a rectangular distribution when only bounds are known).
 * - `95% low..high` states a coverage interval: a two-piece normal with its
 *   mode at the value and exactly that share of probability between the limits.
 * - `normal(sd)`, `lognormal(factor)`, `triangular(low, high)` and
 *   `uniform(low, high)` name the shape outright.
 *
 * In `±` and `normal()`, a percentage is relative to the value. Elsewhere a
 * bound without a unit uses the literal's unit; a bound with a unit must have
 * the same dimensions and is converted. */
export function resolveUncertainty(value: number, unit: string, uncertainty: Uncertainty): Distribution {
  const base = getUnit(unit, uncertainty);
  const label = unit ? ` ${unit}` : '';
  const absolute = (amount: Amount): number => {
    if (!amount.unit) return amount.value;
    const target = getUnit(amount.unit, amount);
    if (!sameDimensions(target.dimensions, base.dimensions))
      fail(
        amount,
        'Units don’t match',
        `This bound is in ${amount.unit}, but the quantity is in ${unit || 'a dimensionless number'}.`,
        `Use ${unit || 'a plain number'}, or leave the unit off to use the quantity’s own.`,
      );
    return (amount.value * target.scale) / base.scale;
  };
  const width = (amount: Amount, what: string): number => {
    if (amount.unit === '%' && value === 0)
      fail(
        amount,
        'A percentage of zero',
        `${plain(amount.value)}% of 0 is no spread at all.`,
        `Give an absolute ${what}, such as ±1${label || ''}.`,
      );
    const size = amount.unit === '%' ? (Math.abs(value) * amount.value) / 100 : absolute(amount);
    if (!(size > 0) || !Number.isFinite(size))
      fail(
        amount,
        'The spread must be positive',
        `A ${what} of ${plain(size)}${label} describes no uncertainty.`,
        `Use a positive ${what}, or remove the clause if the value is exact.`,
      );
    return size;
  };
  const bounds = (low: Amount, high: Amount): [number, number] => {
    const lo = absolute(low),
      hi = absolute(high);
    if (!(lo < hi))
      fail(
        { start: low.start, end: high.end },
        'The range is back to front',
        `${plain(lo)}..${plain(hi)} has no width.`,
        'Write the lower bound first, then the upper bound.',
      );
    if (value < lo || value > hi)
      fail(
        { start: low.start, end: high.end },
        'The range excludes the value',
        `${plain(lo)}..${plain(hi)}${label} doesn’t contain ${plain(value)}${label}.`,
        'Widen the range, or move the value inside it.',
      );
    return [lo, hi];
  };
  const spread = uncertainty.spread;
  switch (spread.kind) {
    case 'plusminus': {
      const w = width(spread.width, 'half-width');
      return { kind: 'uniform', low: value - w, high: value + w };
    }
    case 'normal':
      return { kind: 'normal', mean: value, sd: width(spread.sd, 'standard deviation') };
    case 'lognormal': {
      const factor = spread.factor;
      if ((factor.unit && factor.unit !== 'ratio') || !(factor.value > 1))
        fail(
          factor,
          'A factor above 1 belongs here',
          'lognormal takes a geometric standard deviation: a plain factor greater than 1.',
          'Try lognormal(1.2): about two-thirds of outcomes within ×÷1.2 of the value.',
        );
      if (!(value > 0))
        fail(
          spread,
          'Lognormal needs a positive value',
          `A lognormal quantity is always positive, but this value is ${plain(value)}${label}.`,
          'Use normal(…) or a range for quantities that can be zero or negative.',
        );
      return { kind: 'lognormal', median: value, sigma: Math.log(factor.value) };
    }
    case 'triangular': {
      const [low, high] = bounds(spread.low, spread.high);
      return { kind: 'triangular', low, mode: value, high };
    }
    case 'range': {
      const [low, high] = bounds(spread.low, spread.high);
      if (!spread.coverage) return { kind: 'uniform', low, high };
      const coverage = spread.coverage.value / 100;
      if (!(coverage >= 0.5 && coverage <= 0.9999))
        fail(
          spread.coverage,
          'Coverage out of range',
          'A stated interval should cover between 50% and 99.99% of outcomes.',
          'Use the coverage your source gives, such as 95%.',
        );
      const z = inverseNormal((1 + coverage) / 2);
      return { kind: 'split-normal', mode: value, left: (value - low) / z, right: (high - value) / z, coverage };
    }
  }
}
