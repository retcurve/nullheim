/**
 * A seedable random source.
 *
 * Python's `random.Random(seed)` is load-bearing in the tests — the allocation
 * fairness test runs 60 seeds to prove a one-neighbour slot stays reachable —
 * and Node's stdlib has no seeded generator at all.
 *
 * The sequences this produces are *not* the ones CPython's Mersenne Twister
 * produces, and nothing tries to make them match. No test asserts a specific
 * coordinate for a specific seed; they assert distributional properties, which
 * any decent generator satisfies. What the seed has to buy is reproducibility of
 * a run, not agreement with the old implementation.
 */

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). Throws if `bound` is not a positive integer. */
  below(bound: number): number;
  /** Uniformly pick one element. Throws on an empty list. */
  choice<T>(items: readonly T[]): T;
}

/**
 * mulberry32 — small, fast, and good enough for choosing which open sector gets claimed.
 * Not cryptographic; nothing here needs it to be. Tokens are minted with
 * `node:crypto`, never with this.
 */
export function seeded(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return rngFrom(next);
}

/** The unseeded source, for production. */
export function systemRandom(): Rng {
  return rngFrom(Math.random);
}

function rngFrom(next: () => number): Rng {
  const below = (bound: number): number => {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new Error(`bound must be a positive integer, got ${bound}`);
    }
    return Math.floor(next() * bound);
  };
  return {
    next,
    below,
    choice<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error("cannot choose from an empty list");
      }
      return items[below(items.length)]!;
    },
  };
}
