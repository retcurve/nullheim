/**
 * Judging an uploaded image before it is ever shown to a player.
 *
 * Two verdicts only, deliberately. `clean` publishes immediately; `unsure`
 * stores the image and holds it for a human (`nullheim moderate`) rather
 * than refusing the upload outright. There is no automated third verdict
 * that refuses storage: an upload that classifies "confidently bad" and gets
 * refused *without* spending the claim's one image slot (see
 * `registry.ts`'s `takeClaimImage`) would let one claim try image after
 * image inside its lease, probing for whatever the classifier happens to
 * wave through — free classifier queries an attacker doesn't otherwise get.
 * Every classified image is stored and spends the slot exactly the way an
 * upload already did before this existed, whichever of the two verdicts it
 * gets. `rejected` still exists as a state — see `WorldStore`'s moderation
 * methods — but only a human reaches it, through the takedown half of
 * `nullheim moderate --reject`, never the classifier automatically.
 *
 * `Moderator.check` is handed neither the original upload nor the stored
 * WebP, but `image-processing.ts`'s third output — a small JPEG built from
 * the same decode, downscaled specifically for a classifier rather than for
 * display (`MAX_CLASSIFICATION_WIDTH`). That size was arrived at by
 * measuring against the real classifier, not assumed: Workers AI billed a
 * roughly flat per-image cost at and below it regardless of the original's
 * resolution, and cost above it scaled with resolution — so anything larger
 * was wasted, and nothing was gained by going smaller than what recall was
 * checked against. See CLAUDE.md's moderation entry for the numbers.
 */

export type Verdict = "clean" | "unsure";

export interface ModerationResult {
  readonly verdict: Verdict;
  /**
   * A numeric confidence from the classifier, kept only for a human
   * reviewer's context — never load-bearing for the verdict split itself.
   * Null when the classifier answers with a verdict directly (a
   * vision-language model prompted for a judgement) rather than a
   * calibrated score.
   */
  readonly score: number | null;
}

export interface Moderator {
  /** Classify one upload. Never throws for a "bad" image — that is a verdict. */
  check(bytes: Uint8Array, contentType: string): Promise<ModerationResult>;
}
