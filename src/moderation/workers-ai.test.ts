/**
 * The classifier's parsing, driven through `workersAiModerator` itself
 * rather than by exporting the private function it is really testing —
 * `AiBinding` is already the seam a fake belongs at, so these run the
 * whole moderator with the model's reply as the only input.
 *
 * What is being guarded is one asymmetry: a wrong UNSURE costs a human
 * glance, a wrong CLEAN publishes something unreviewed permanently. So
 * every reply that is not eight explicit Noes has to come back UNSURE,
 * and the cases below are the ways a real model has been seen to fall
 * short of that — hedging prose, a refusal, a truncated answer — plus the
 * ways a careless parser would let one through.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { workersAiModerator } from "./workers-ai.ts";

function replying(response: unknown) {
  return workersAiModerator({ async run() { return { response }; } });
}

const ALL_NO = Array.from({ length: 8 }, (_, i) => `Question ${i + 1}: No`).join("\n");

describe("the classifier's verdict", () => {
  test("eight explicit Noes is the only clean answer", async () => {
    const { verdict, score } = await replying(ALL_NO).check(new Uint8Array(), "image/webp");
    assert.equal(verdict, "clean");
    assert.equal(score, null);
  });

  test("the bracketed form the prompt asks for is read the same way", async () => {
    const bracketed = ALL_NO.replaceAll(/No$/gm, "[No]");
    assert.equal((await replying(bracketed).check(new Uint8Array(), "image/webp")).verdict, "clean");
  });

  test("any single Yes is unsure, whichever question it answers", async () => {
    for (let n = 1; n <= 8; n++) {
      const lines = ALL_NO.split("\n");
      lines[n - 1] = `Question ${n}: Yes`;
      const { verdict } = await replying(lines.join("\n")).check(new Uint8Array(), "image/webp");
      assert.equal(verdict, "unsure", `a Yes on question ${n} must not read as clean`);
    }
  });

  /**
   * The truncation case. A reply cut short by `max_tokens` ends in a run of
   * Noes, so a parser that asked "did anything say Yes?" would call it
   * clean — the questions it never reached are exactly the ones it says
   * nothing about.
   */
  test("a short answer is unsure, not clean by omission", async () => {
    const firstThree = ALL_NO.split("\n").slice(0, 3).join("\n");
    assert.equal((await replying(firstThree).check(new Uint8Array(), "image/webp")).verdict, "unsure");
  });

  test("a hedge or a refusal is unsure", async () => {
    // Both observed from the live model, 2026-09-04.
    for (const reply of [
      "I'm unable to classify the image against the given categories.",
      "I'm sorry, but I can't assist with that request.",
      "I cannot determine the level of disturbance or shock value of this image.",
      "",
    ]) {
      const { verdict } = await replying(reply).check(new Uint8Array(), "image/webp");
      assert.equal(verdict, "unsure", `"${reply}" must not read as clean`);
    }
  });

  test("a reply that is not a string at all is unsure", async () => {
    for (const reply of [undefined, null, 42, { answer: "no" }]) {
      const { verdict } = await replying(reply).check(new Uint8Array(), "image/webp");
      assert.equal(verdict, "unsure");
    }
  });

  /**
   * Answers are matched by question number, not by position, so prose
   * between them cannot slide one question's answer onto another's.
   */
  test("surrounding prose does not shift which answer belongs to which question", async () => {
    const chatty = `Here is my inspection:\n\n${ALL_NO.split("\n").join("\n\n")}\n\nLet me know if you need more.`;
    assert.equal((await replying(chatty).check(new Uint8Array(), "image/webp")).verdict, "clean");

    const shifted = `Question 7: Yes\n${ALL_NO}`;
    assert.equal((await replying(shifted).check(new Uint8Array(), "image/webp")).verdict, "unsure");
  });
});
