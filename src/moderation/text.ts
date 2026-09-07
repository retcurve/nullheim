/**
 * Checks authored prose (sector and object titles and descriptions) with a
 * text chat model behind Cloudflare Workers AI. Like the image checker, the
 * model is asked Yes/No questions about the text rather than for a verdict.
 * Unlike the image checker, there is no queue: a flagged field refuses the
 * submission outright.
 *
 * The Cloudflare account calling this model must first send it one request
 * with `{"prompt": "agree"}` before any other call succeeds.
 *
 * `AiBinding` declares only the shape this file uses, rather than the
 * ambient `Ai` type Workers ships. `worker.ts` adapts `env.AI` to this
 * shape.
 */

import type { TextCheckResult, TextModerator } from "../moderation.ts";

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const MODEL = "@cf/meta/llama-3.2-3b-instruct";

/** The system turn: demands the exact Yes/No line format and nothing else. */
const SYSTEM = "You are a sterile content classifier. Reply with ONLY the five lines, in this exact format, one answer (Yes or No) per line, and no other text at all:\nQuestion 1: [Yes/No]\nQuestion 2: [Yes/No]\nQuestion 3: [Yes/No]\nQuestion 4: [Yes/No]\nQuestion 5: [Yes/No]";

/** Asks one Yes/No question per category, covering five categories of content. */
const QUESTIONS = `1. Does this text contain nudity or explicit romantic content?
2. Does this text contain vulgar or profane language?
3. Does this text contain hate speech or extremist symbols?
4. Does this text encourage or graphically describe self-harm or suicide?
5. Does this text sexualise a child in any way?

Here is the prose to inspect:
`;

/**
 * Returns `ok` only if all five questions are found, each answered No.
 * Any missing question, unparseable line, or Yes answer fails the check.
 * Each answer is located by its question number rather than by line order.
 *
 * Accepts both the `Question N: [Yes/No]` form the prompt demands and the
 * bare `N. Yes/No` (or `N) Yes/No`) form the 3B model actually returns, so
 * a reply like `1. No` is not misread as a missing answer. Every other
 * format is a failure, and a model that answers with prose instead of the
 * numbered lines still rejects.
 */
function parseVerdict(output: Record<string, unknown>): TextCheckResult {
  const text = typeof output.response === "string" ? output.response : "";
  const categories = [
    "nudity or explicit romantic content",
    "vulgar or profane language",
    "hate speech or extremist symbols",
    "self-harm or suicide",
    "sexualisation of a child",
  ];
  const patterns = (n: number) => [
    new RegExp(`question\\s*${n}\\s*:\\s*\\[?\\s*(yes|no)\\b`, "i"),
    new RegExp(`\\b${n}\\s*[.):]\\s*\\[?\\s*(yes|no)\\b`, "i"),
  ];
  for (let n = 1; n <= 5; n++) {
    let answer: RegExpMatchArray | null = null;
    for (const pattern of patterns(n)) {
      answer = pattern.exec(text);
      if (answer !== null) {
        break;
      }
    }
    if (answer === null || answer[1]!.toLowerCase() !== "no") {
      return {
        ok: false,
        reason: answer
          ? `flagged for ${categories[n - 1]} (question ${n})`
          : `question ${n} was missing or unparseable in the classifier's reply`,
      };
    }
  }
  return { ok: true, reason: null };
}

export function workersAiTextModerator(ai: AiBinding): TextModerator {
  return {
    async check(text) {
      const output = await ai.run(MODEL, {
        // A chat-messages form, which the instruct model obeys far more
        // strictly than a flat prompt (which it answers with more prose,
        // never the Yes/No lines). The prose sits in the user turn.
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: QUESTIONS + text },
        ],
        // Caps the reply length; a truncated reply is read as a failure by parseVerdict.
        max_tokens: 120,
      });
      return parseVerdict(output);
    },
  };
}