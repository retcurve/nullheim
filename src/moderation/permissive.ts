/**
 * Local dev and tests: no network, one fixed verdict every time.
 *
 * Configurable so a test can exercise the `unsure` path (a pending image
 * `readImage` refuses and `sectorView` omits) without a real classifier —
 * see api.test.ts's moderation tests.
 */

import type { Moderator, Verdict } from "../moderation.ts";

export function permissiveModerator(verdict: Verdict = "clean"): Moderator {
  return {
    async check() {
      return { verdict, score: null };
    },
  };
}
