/**
 * Tests for workersAiTextModerator's parsing of the model's reply text, using
 * a fake AiBinding that returns a given reply and checking whether the check
 * passes or refuses.
 *
 * The 3B model answers both in the `Question N: [Yes/No]` form the prompt
 * demands and in the bare `N. Yes/No` form, so both must be read as answers.
 * Anything else — a missing line, a Yes, prose instead of numbers — must
 * refuse, never pass by omission.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { workersAiTextModerator } from "../../src/moderation/text.ts";

function replying(response: unknown) {
  return workersAiTextModerator({ async run() { return { response }; } });
}

const QUESTION_FORM = Array.from({ length: 5 }, (_, i) => `Question ${i + 1}: No`).join("\n");
const BARE_FORM = Array.from({ length: 5 }, (_, i) => `${i + 1}. No`).join("\n");
const BARE_PAREN_FORM = Array.from({ length: 5 }, (_, i) => `${i + 1}) No`).join("\n");

describe("the classifier's verdict", () => {
  test("five explicit Noes in the Question form is the only clean answer", async () => {
    assert.equal((await replying(QUESTION_FORM).check("x")).ok, true);
  });

  test("the bare numbered form the 3B model returns is read the same way", async () => {
    assert.equal((await replying(BARE_FORM).check("x")).ok, true);
    assert.equal((await replying(BARE_PAREN_FORM).check("x")).ok, true);
  });

  test("a bracketed answer inside either form is read the same way", async () => {
    assert.equal((await replying(BARE_FORM.replace(/No$/gm, "[No]")).check("x")).ok, true);
    assert.equal((await replying(QUESTION_FORM.replace(/No$/gm, "[No]")).check("x")).ok, true);
  });

  test("any single Yes refuses, whichever form and question", async () => {
    for (const template of [QUESTION_FORM, BARE_FORM]) {
      for (let n = 1; n <= 5; n++) {
        const lines = template.split("\n");
        lines[n - 1] = `${n}. Yes`;
        const { ok } = await replying(lines.join("\n")).check("x");
        assert.equal(ok, false, `a Yes on question ${n} must not pass`);
      }
    }
  });

  test("a short or missing answer refuses, not passes by omission", async () => {
    for (const reply of [
      BARE_FORM.split("\n").slice(0, 3).join("\n"),
      QUESTION_FORM.split("\n").slice(0, 2).join("\n"),
      "",
    ]) {
      assert.equal((await replying(reply).check("x")).ok, false, `"${reply}" must refuse`);
    }
  });

  test("a reply that continues the prose instead of answering refuses", async () => {
    for (const reply of [
      "The shadows are long and deep, like dark rivers, and the figure is bent forward in the lamplight.",
      "It is a quiet scene and nothing much happens here, which is fine.",
    ]) {
      assert.equal((await replying(reply).check("x")).ok, false);
    }
  });

  test("a refusal or a non-string reply refuses", async () => {
    for (const reply of ["I can't answer that.", undefined, null, 42, { answer: "no" }]) {
      assert.equal((await replying(reply).check("x")).ok, false);
    }
  });
});