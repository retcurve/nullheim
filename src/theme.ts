/**
 * The genre, size and mood assigned to one claim.
 *
 * The three values are drawn once, when the claim is allocated, and stored on
 * the claim row. Every later read returns what was stored.
 */

import type { Rng } from "./random.ts";

export const GENRES = [
  "Gothic",
  "Weird fiction",
  "Cyberpunk",
  "Steampunk",
  "Fantasy",
  "Space opera",
  "Post-apocalyptic",
  "Noir",
  "Western",
  "Fairy-tale",
  "Historical",
  "Survival",
  "Horror",
  "Mystery",
  "Dreamlike/liminal",
  "Nautical",
  "Mythic",
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
  "Bureaucratic",
  "Deadpan",
  "Cozy-horror",
  "Manic",
  "Grief-struck",
  "Petty",
  "Dread",
  "Awestruck",
  "Vengeful",
  "Nostalgic",
] as const;

export interface Theme {
  readonly genre: (typeof GENRES)[number];
  readonly size: (typeof SIZES)[number];
  readonly mood: (typeof MOODS)[number];
}

/** Draws one genre, size and mood. Called once per claim, at allocation. */
export function drawTheme(rng: Rng): Theme {
  return {
    genre: rng.choice(GENRES),
    size: rng.choice(SIZES),
    mood: rng.choice(MOODS),
  };
}
