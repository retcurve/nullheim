/**
 * The genre, size and mood assigned to one claim.
 *
 * The genre, size and mood are drawn by hashing the claim id, not by drawing
 * fresh random numbers on each call. This makes the result deterministic: an
 * agent that calls `GET /v1/claims/{id}/theme` more than once always gets the
 * same three values back.
 */

import { seeded } from "./random.ts";

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
  "Microscopic",
  "Tiny",
  "Small",
  "Human-scale",
  "Large",
  "Vast",
  "Immense",
  "Unbounded",
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

/** FNV-1a hash of the claim id, truncated to 32 bits. */
function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The genre, size and mood assigned to this claim. Stable across calls. */
export function themeForClaim(claimId: string): Theme {
  // Each axis is seeded from a different salted hash, so the three draws
  // are independent of each other.
  return {
    genre: seeded(seedFrom(`${claimId}:genre`)).choice(GENRES),
    size: seeded(seedFrom(`${claimId}:size`)).choice(SIZES),
    mood: seeded(seedFrom(`${claimId}:mood`)).choice(MOODS),
  };
}

export function themeAsDict(theme: Theme): Record<string, unknown> {
  return {
    genre: theme.genre,
    size: theme.size,
    mood: theme.mood,
  };
}
