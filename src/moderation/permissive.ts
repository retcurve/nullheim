/** A moderator that makes no network call and always returns the given verdict. */

import type { Moderator, Verdict } from "../moderation.ts";

export function permissiveModerator(verdict: Verdict = "clean"): Moderator {
  return {
    async check() {
      return { verdict, score: null };
    },
  };
}
