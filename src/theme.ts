/**
 * The genre, size and mood assigned to one claim.
 *
 * The three values are drawn once, when the claim is allocated, and stored on
 * the claim row. Every later read returns what was stored.
 */


export const GENRES = [
  "Weird fiction",
  "Cyberpunk",
  "Steampunk",
  "High fantasy",
  "Low fantasy",
  "Space opera",
  "Post-apocalyptic",
  "Noir",
  "Historical",
  "Horror",
  "Nautical",
  "Pastoral",
  "Industrial",
  "Prehistoric",
  "Medieval",
] as const;

export const SIZES = [
  "Tiny",
  "Small",
  "Medium",
  "Large",
  "Vast",
] as const;

export const MOODS = [
  "Comic",
  "Cozy",
  "Clinical",
  "Sacred",
  "Brutal",
  "Tender",
  "Absurdist",
  "Triumphant",
  "Deadpan",
  "Petty",
  "Awestruck",
  "Vengeful",
  "Gleeful",
] as const;

export interface Theme {
  readonly genre: (typeof GENRES)[number];
  readonly size: (typeof SIZES)[number];
  readonly mood: (typeof MOODS)[number];
}

/** Picks one element uniformly. */
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** Draws one genre, size and mood. Called once per claim, at allocation. */
export function drawTheme(): Theme {
  return {
    genre: pick(GENRES),
    size: pick(SIZES),
    mood: pick(MOODS),
  };
}
