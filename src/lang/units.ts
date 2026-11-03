import { fail, type Span } from './types';
export interface Rational {
  n: number;
  d: number;
}
export type Dimensions = Record<string, Rational>;
export interface Unit {
  symbol: string;
  scale: number;
  dimensions: Dimensions;
}
const internalSpan = { start: 0, end: 1 };
function reduced(n: bigint, d: bigint): Rational {
  if (d === 0n)
    return fail(
      internalSpan,
      'Unit too complex',
      'A unit exponent has a zero denominator.',
      'Use a non-zero rational denominator.',
    );
  let a = n < 0n ? -n : n,
    b = d < 0n ? -d : d;
  while (b !== 0n) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  const sign = d < 0n ? -1n : 1n;
  const numerator = Number((n / a) * sign),
    denominator = Number((d / a) * sign);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator))
    return fail(
      internalSpan,
      'Unit too complex',
      'This dimension exceeds the exact rational representation limit.',
      'Use fewer repeated roots or split the dimensional calculation.',
    );
  return { n: numerator, d: denominator };
}
export function rational(n: number, d = 1): Rational {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d))
    return fail(
      internalSpan,
      'Unit too complex',
      'Unit exponents must be exact integers.',
      'Use smaller rational exponents.',
    );
  return reduced(BigInt(n), BigInt(d));
}
const add = (a: Rational, b: Rational) =>
  reduced(BigInt(a.n) * BigInt(b.d) + BigInt(b.n) * BigInt(a.d), BigInt(a.d) * BigInt(b.d));
const finiteScale = (scale: number): number => {
  if (!Number.isFinite(scale) || scale <= 0)
    return fail(
      internalSpan,
      'Unit scale out of range',
      'This unit scale is too large or too small to represent.',
      'Convert to base units before multiplying or taking further powers.',
    );
  return scale;
};
export const multiplyDimensions = (a: Dimensions, b: Dimensions, sign = 1): Dimensions => {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const sum = add(result[key] ?? rational(0), rational(value.n * sign, value.d));
    if (sum.n) result[key] = sum;
    else delete result[key];
  }
  return result;
};
export const sameDimensions = (a: Dimensions, b: Dimensions): boolean =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (key) =>
      BigInt(a[key]?.n ?? 0) * BigInt(b[key]?.d ?? 1) ===
      BigInt(b[key]?.n ?? 0) * BigInt(a[key]?.d ?? 1),
  );
const dim = (values: Record<string, number>): Dimensions =>
  Object.fromEntries(Object.entries(values).map(([key, n]) => [key, rational(n)]));
const energy = dim({ mass: 1, length: 2, time: -2 });
const registry: Record<string, Unit> = {};
function define(symbol: string, scale: number, dimensions: Dimensions) {
  registry[symbol] = { symbol, scale, dimensions };
}
define('', 1, {});
define('ratio', 1, {});
define('%', 0.01, {});
for (const [symbol, scale] of [
  ['kg', 1],
  ['g', 0.001],
  ['mg', 0.000001],
  ['t', 1000],
] as const)
  define(symbol, scale, dim({ mass: 1 }));
for (const [symbol, scale] of [
  ['m', 1],
  ['km', 1000],
  ['cm', 0.01],
  ['mm', 0.001],
  ['mi', 1609.344],
] as const)
  define(symbol, scale, dim({ length: 1 }));
for (const [symbol, scale] of [
  ['s', 1],
  ['min', 60],
  ['h', 3600],
  ['day', 86400],
  ['year', 31557600],
] as const)
  define(symbol, scale, dim({ time: 1 }));
for (const [symbol, scale] of [
  ['J', 1],
  ['kJ', 1000],
  ['MJ', 1e6],
  ['GJ', 1e9],
  ['TJ', 1e12],
  ['Wh', 3600],
  ['kWh', 3.6e6],
] as const)
  define(symbol, scale, energy);
define('W', 1, dim({ mass: 1, length: 2, time: -3 }));
define('kW', 1000, dim({ mass: 1, length: 2, time: -3 }));
define('L', 0.001, dim({ length: 3 }));
define('mL', 0.000001, dim({ length: 3 }));
define('£', 1, dim({ currency: 1 }));
for (const symbol of ['A', 'K', 'mol', 'cd']) define(symbol, 1, dim({ [symbol]: 1 }));
// Named, multiplicative SI derived units. Absolute Celsius needs affine
// arithmetic and is deliberately excluded; use kelvin for temperature.
const derivedUnits: Record<string, Record<string, number>> = {
  Hz: { time: -1 },
  N: { mass: 1, length: 1, time: -2 },
  Pa: { mass: 1, length: -1, time: -2 },
  C: { A: 1, time: 1 },
  V: { mass: 1, length: 2, time: -3, A: -1 },
  F: { mass: -1, length: -2, time: 4, A: 2 },
  Ω: { mass: 1, length: 2, time: -3, A: -2 },
  ohm: { mass: 1, length: 2, time: -3, A: -2 },
  S: { mass: -1, length: -2, time: 3, A: 2 },
  Wb: { mass: 1, length: 2, time: -2, A: -1 },
  T: { mass: 1, time: -2, A: -1 },
  H: { mass: 1, length: 2, time: -2, A: -2 },
  lm: { cd: 1 },
  lx: { cd: 1, length: -2 },
  Bq: { time: -1 },
  Gy: { length: 2, time: -2 },
  Sv: { length: 2, time: -2 },
  kat: { mol: 1, time: -1 },
  rad: {},
  sr: {},
};
for (const [symbol, dimensions] of Object.entries(derivedUnits)) define(symbol, 1, dim(dimensions));
export const unitNames = Object.keys(registry).filter(Boolean);
export const isUnit = (name: string): boolean => Object.hasOwn(registry, name) && name !== '';
export function powerUnit(unit: Unit, power: Rational): Unit {
  const dimensions: Dimensions = {};
  for (const [key, value] of Object.entries(unit.dimensions)) {
    const exponent = reduced(BigInt(value.n) * BigInt(power.n), BigInt(value.d) * BigInt(power.d));
    if (exponent.n) dimensions[key] = exponent;
  }
  const scale = finiteScale(unit.scale ** (power.n / power.d));
  const named = Object.values(registry).find(
    (candidate) =>
      Math.abs(candidate.scale - scale) <= Math.abs(scale) * 1e-12 &&
      sameDimensions(candidate.dimensions, dimensions),
  );
  return { symbol: named?.symbol ?? `(${unit.symbol})^(${power.n}/${power.d})`, scale, dimensions };
}
export function combineUnits(a: Unit, b: Unit, op: '*' | '/'): Unit {
  const dimensions = multiplyDimensions(a.dimensions, b.dimensions, op === '*' ? 1 : -1);
  const scale = finiteScale(op === '*' ? a.scale * b.scale : a.scale / b.scale);
  const exact = Object.values(registry).find(
    (unit) =>
      Math.abs(unit.scale - scale) <= Math.abs(scale) * 1e-12 &&
      sameDimensions(unit.dimensions, dimensions),
  );
  const symbol =
    exact?.symbol ??
    (op === '*'
      ? [a.symbol, b.symbol].filter(Boolean).join('·')
      : `${a.symbol || 'ratio'}/${b.symbol || 'ratio'}`);
  return { symbol, scale, dimensions };
}
export function getUnit(text: string, span: Span = { start: 0, end: 1 }): Unit {
  if (Object.hasOwn(registry, text))
    return registry[text] ?? { symbol: '', scale: 1, dimensions: {} };
  const parts = text.split(/([*/])/);
  let result: Unit | undefined;
  let op: '*' | '/' = '*';
  for (const part of parts) {
    if (part === '*' || part === '/') {
      op = part;
      continue;
    }
    const match = /^([^^]+)(?:\^\((-?\d+)\/(\d+)\)|\^(-?\d+))?$/.exec(part);
    const base = match?.[1] ? registry[match[1]] : undefined;
    if (!base)
      return fail(
        span,
        'Unknown unit',
        `“${part}” is not a known unit.`,
        'Try kg, kWh, km, L, £, %, or a compound such as kg/kWh.',
      );
    const unit = match?.[2]
      ? powerUnit(base, rational(Number(match[2]), Number(match[3])))
      : match?.[4]
        ? powerUnit(base, rational(Number(match[4])))
        : base;
    result = result ? combineUnits(result, unit, op) : unit;
  }
  return { ...(result ?? registry[''] ?? { scale: 1, dimensions: {} }), symbol: text };
}
export const compatible = (a: Unit, b: Unit, span: Span, operation = 'adding'): void => {
  if (!sameDimensions(a.dimensions, b.dimensions))
    fail(
      span,
      'Units don’t add up',
      `You’re ${operation} ${a.symbol || 'a dimensionless number'} to ${b.symbol || 'a dimensionless number'}.`,
      a.symbol === 'kWh' && b.symbol === 'kg'
        ? 'Did you mean to multiply by an emission factor (kg/kWh)?'
        : 'Use quantities with matching dimensions, or multiply by a conversion factor.',
    );
};
