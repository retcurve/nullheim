import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { GENRES, MOODS, SIZES, themeForClaim } from "./theme.ts";

describe("themeForClaim", () => {
  test("is deterministic in the claim id", () => {
    const a = themeForClaim("claim_deadbeefcafebabe");
    const b = themeForClaim("claim_deadbeefcafebabe");
    assert.deepEqual(a, b);
  });

  test("draws each axis from its own list", () => {
    const theme = themeForClaim("claim_0123456789abcdef");
    assert.ok((GENRES as readonly string[]).includes(theme.genre));
    assert.ok((SIZES as readonly string[]).includes(theme.size));
    assert.ok((MOODS as readonly string[]).includes(theme.mood));
  });

  test("different claims are not all handed the same theme", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const theme = themeForClaim(`claim_${i}`);
      seen.add(`${theme.genre}/${theme.size}/${theme.mood}`);
    }
    assert.ok(seen.size > 1);
  });
});
