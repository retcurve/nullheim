/**
 * The genre, size and mood assigned to one claim.
 *
 * A model asked to "pick a genre at random" does not — it reaches for
 * whatever is most probable given everything else in the prompt, which is
 * exactly the shared-input problem `CLAUDE.md`'s "Deliberate decisions"
 * section describes for every other kind of content guidance. Self-selected
 * "random" genre and size produced the same handful of favourites over and
 * over. So the choice is made here, by a real RNG, and handed to the agent
 * as a fact rather than a request.
 *
 * The choice is deterministic in the claim id, not drawn fresh on every call:
 * `claim_id` already comes from `crypto.getRandomValues` (see
 * `registry.ts`'s `allocate()`), so hashing it is exactly as random as
 * drawing three fresh numbers would be, and it buys idempotency for free — an
 * agent that calls `GET /v1/claims/{id}/theme` twice, or crashes and refetches
 * its claim, gets the same three words back both times.
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

/**
 * FNV-1a over the claim id, truncated to 32 bits. Not cryptographic, and
 * does not need to be: the input is already unpredictable, this only needs
 * to spread it, and `seeded()` (see `random.ts`) is not a cryptographic
 * generator either.
 */
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
  // Three draws from one seeded stream would correlate their positions if
  // the same index into all three lists always came out together; salting
  // the seed per axis keeps the draws independent of each other.
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
