/** Seeded uniform streams for Monte Carlo sampling.
 *
 * Generator: xoshiro128** (Blackman & Vigna, "Scrambled linear pseudorandom
 * number generators", ACM TOMS 47(4), 2021). Its four 32-bit state words are
 * seeded by splitmix32, a murmur3-style finaliser, so nearby seeds and stream
 * names still start from unrelated states. Math.imul keeps every step exact. */
const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** Raw xoshiro128** from four explicit state words (for reference vectors). */
export function xoshiro128ss(a: number, b: number, c: number, d: number): () => number {
  let s0 = a | 0,
    s1 = b | 0,
    s2 = c | 0,
    s3 = d | 0;
  return () => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
}

/** FNV-1a: a stable 32-bit name for a stream, so a quantity keeps its own
 * random numbers when unrelated lines are edited (common random numbers). */
function hashName(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stream(seed: number, name: string): () => number {
  const mix = splitmix32((seed >>> 0) ^ hashName(name));
  const words = [mix(), mix(), mix(), mix()];
  if (!words.some(Boolean)) words[0] = 1;
  return xoshiro128ss(words[0] ?? 1, words[1] ?? 0, words[2] ?? 0, words[3] ?? 0);
}

/** Fills `out` with uniforms strictly inside (0, 1): (k + ½) / 2³². Inverse
 * CDFs never see 0 or 1, so no sample is infinite. */
export function fillUniform(out: Float64Array, seed: number, name: string): Float64Array {
  const next = stream(seed, name);
  for (let i = 0; i < out.length; i++) out[i] = (next() + 0.5) / 4294967296;
  return out;
}
