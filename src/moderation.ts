/**
 * Classifies an uploaded image as `clean` (published immediately) or
 * `unsure` (stored and held for human review via `nullheim moderate`).
 * A human reviewer can separately mark an image `rejected`, taking it down.
 * `check` receives the downscaled classification JPEG produced by
 * `image-processing.ts`, not the original upload or the stored image.
 */

export type Verdict = "clean" | "unsure";

export interface ModerationResult {
  readonly verdict: Verdict;
  /** A numeric confidence score, shown to a human reviewer. Null when the classifier gives a verdict directly. */
  readonly score: number | null;
}

export interface Moderator {
  /** Classifies one upload, returning a verdict rather than throwing. */
  check(bytes: Uint8Array, contentType: string): Promise<ModerationResult>;
}
