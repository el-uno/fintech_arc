/*
 * The only file in Arc permitted float arithmetic.
 *
 * A PRNG is not money: these are bit-mixing operations on a 32-bit state, and
 * `Math.floor` here is integer truncation of a generated fraction, not the
 * rounding of a monetary value. Nothing produced by this file may be used as
 * an amount — fee simulation converts its output to bigint minor units in
 * simulator.ts before any Money is constructed.
 */
/* eslint-disable no-restricted-properties */

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  /** True with probability `bps / 10_000`. */
  chance(bps: number): boolean;
  hex(length: number): string;
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and reproducible across runs and platforms. */
export function createRng(seed: string): Rng {
  let state = hashSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    chance: (bps: number) => next() * 10_000 < bps,
    hex: (length: number) => {
      let out = '';
      while (out.length < length) {
        out += Math.floor(next() * 0xffffffff)
          .toString(16)
          .padStart(8, '0');
      }
      return out.slice(0, length);
    },
  };
}
