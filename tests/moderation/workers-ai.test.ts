/**
 * Tests for workersAiModerator's parsing of the model's reply text, using a
 * fake AiBinding that returns a given reply and checking the resulting
 * verdict.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { workersAiModerator } from "../../src/moderation/workers-ai.ts";

function replying(response: unknown) {
  return workersAiModerator({ async run() { return { response }; } });
}

const ALL_NO = Array.from({ length: 5 }, (_, i) => `Question ${i + 1}: No`).join("\n");

describe("the classifier's verdict", () => {
  test("five explicit Noes is the only clean answer", async () => {
    const { verdict, score } = await replying(ALL_NO).check(new Uint8Array(), "image/webp");
    assert.equal(verdict, "clean");
    assert.equal(score, null);
  });

  test("the bracketed form the prompt asks for is read the same way", async () => {
    const bracketed = ALL_NO.replaceAll(/No$/gm, "[No]");
    assert.equal((await replying(bracketed).check(new Uint8Array(), "image/webp")).verdict, "clean");
  });

  test("the bare numbered form is read the same way", async () => {
    const bare = Array.from({ length: 5 }, (_, i) => `${i + 1}. No`).join("\n");
    assert.equal((await replying(bare).check(new Uint8Array(), "image/webp")).verdict, "clean");
  });

  test("any single Yes is unsure, whichever question it answers", async () => {
    for (let n = 1; n <= 5; n++) {
      const lines = ALL_NO.split("\n");
      lines[n - 1] = `Question ${n}: Yes`;
      const { verdict } = await replying(lines.join("\n")).check(new Uint8Array(), "image/webp");
      assert.equal(verdict, "unsure", `a Yes on question ${n} must not read as clean`);
    }
  });

  test("a short answer is unsure, not clean by omission", async () => {
    const firstThree = ALL_NO.split("\n").slice(0, 3).join("\n");
    assert.equal((await replying(firstThree).check(new Uint8Array(), "image/webp")).verdict, "unsure");
  });

  test("a hedge or a refusal is unsure", async () => {
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

  test("surrounding prose does not shift which answer belongs to which question", async () => {
    const chatty = `Here is my inspection:\n\n${ALL_NO.split("\n").join("\n\n")}\n\nLet me know if you need more.`;
    assert.equal((await replying(chatty).check(new Uint8Array(), "image/webp")).verdict, "clean");

    const shifted = `Question 5: Yes\n${ALL_NO}`;
    assert.equal((await replying(shifted).check(new Uint8Array(), "image/webp")).verdict, "unsure");
  });
});
