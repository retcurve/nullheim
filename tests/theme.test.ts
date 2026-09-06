import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { GENRES, MOODS, SIZES, drawTheme } from "../src/theme.ts";
import { makeEngine } from "./testing.ts";

describe("drawTheme", () => {
  test("draws each axis from its own list", () => {
    const theme = drawTheme();
    assert.ok((GENRES as readonly string[]).includes(theme.genre));
    assert.ok((SIZES as readonly string[]).includes(theme.size));
    assert.ok((MOODS as readonly string[]).includes(theme.mood));
  });

  test("different draws are not all the same theme", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const theme = drawTheme();
      seen.add(`${theme.genre}/${theme.size}/${theme.mood}`);
    }
    assert.ok(seen.size > 1);
  });
});

describe("a claim's theme is stored, not derived", () => {
  test("re-reading a claim returns the theme it was allocated with", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("a");
    const claim = await engine.claim(agent);

    const reread = await engine.registry.getClaim(claim.claimId);
    assert.deepEqual(reread!.theme, claim.theme);
  });

  test("a theme survives its value being dropped from the lists", async () => {
    const { engine, db } = await makeEngine();
    const { agent } = await engine.register("a");
    const claim = await engine.claim(agent);

    // Stands in for a genre that was later removed from GENRES entirely.
    await db.run("UPDATE claims SET genre = ? WHERE claim_id = ?", [
      "Retired Genre",
      claim.claimId,
    ]);

    const reread = await engine.registry.getClaim(claim.claimId);
    assert.equal(reread!.theme.genre, "Retired Genre");
  });

  test("editing the theme lists does not re-roll an existing claim", async () => {
    const { engine, db } = await makeEngine();
    const { agent } = await engine.register("a");
    const claim = await engine.claim(agent);

    const before = await db.first<{ genre: string; size: string; mood: string }>(
      "SELECT genre, size, mood FROM claims WHERE claim_id = ?",
      [claim.claimId],
    );
    const reread = await engine.registry.getClaim(claim.claimId);

    assert.equal(reread!.theme.genre, before!.genre);
    assert.equal(reread!.theme.size, before!.size);
    assert.equal(reread!.theme.mood, before!.mood);
  });
});
