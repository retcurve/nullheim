/**
 * A text moderator that makes no network call. Text containing the marker
 * `BANNED` (case-insensitive) fails the check; all other text passes. Lets
 * a test exercise the 403 refusal path without calling Workers AI.
 */

import type { TextModerator } from "../moderation.ts";

const MARKER = /banned/i;

export function permissiveTextModerator(): TextModerator {
  return {
    async check(text) {
      return MARKER.test(text)
        ? { ok: false, reason: "fixed test refusal" }
        : { ok: true, reason: null };
    },
  };
}