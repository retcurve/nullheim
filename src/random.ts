/**
 * A seedable random source.
 *
 * Given the same seed, produces the same sequence of values every time.
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
 * mulberry32, a small non-cryptographic pseudorandom generator.
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

/** An unseeded source backed by `Math.random`. */
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
