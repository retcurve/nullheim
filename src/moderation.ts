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
  /** Why an `unsure` verdict came back. Null for `clean`. */
  readonly reason: string | null;
}

export interface Moderator {
  /** Classifies one upload, returning a verdict rather than throwing. */
  check(bytes: Uint8Array, contentType: string): Promise<ModerationResult>;
}

/** The result of a text-moderation check on authored prose. `ok` true means the text may be stored. */
export interface TextCheckResult {
  readonly ok: boolean;
  /** Which category the text was flagged for. Null when `ok` is true. */
  readonly reason: string | null;
}

/** Checks authored prose (titles and descriptions) before it is stored, returning a verdict rather than throwing. */
export interface TextModerator {
  check(text: string): Promise<TextCheckResult>;
}
