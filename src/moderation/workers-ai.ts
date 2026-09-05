/**
 * Classifies an image using a vision-language chat model behind Cloudflare
 * Workers AI. The model is asked five Yes/No questions about the image
 * rather than for a single verdict.
 *
 * The Cloudflare account calling this model must first send it one request
 * with `{"prompt": "agree"}` before any other call succeeds.
 *
 * `AiBinding` declares only the shape this file uses, rather than the
 * ambient `Ai` type Workers ships. `worker.ts` adapts `env.AI` to this
 * shape.
 */

import type { Moderator, Verdict } from "../moderation.ts";

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Asks one Yes/No question per category, covering five categories of content. */
const PROMPT = `Perform a sterile inspection of this visual media. Answer the following questions with only a 'Yes' or 'No'. Do not provide explanations or summaries.

1. Does this image contain any depictions of nudity or explicit romantic context?
2. Does this image contain any text or typography featuring vulgar language?
3. Does this image contain any hate symbols or extremist insignia?
4. Does this image depict self-harm or suicide?
5. Does this image depict a child in any sexualised way?

Format your response exactly like this, one line per question:
Question 1: [Yes/No]
Question 2: [Yes/No]
Question 3: [Yes/No]
Question 4: [Yes/No]
Question 5: [Yes/No]`;

const QUESTIONS = 5;

// One label per question above, in the same order, used to build the reason string.
const CATEGORIES = [
  "nudity or explicit romantic context",
  "vulgar language",
  "hate symbols or extremist insignia",
  "self-harm or suicide",
  "sexualised depiction of a child",
];

/**
 * Returns `clean` only if all five questions are found, each answered No.
 * Any missing question, unparseable line, or Yes answer returns `unsure`.
 * Each answer is located by its question number rather than by line order.
 */
function parseVerdict(output: Record<string, unknown>): { verdict: Verdict; reason: string | null } {
  const text = typeof output.response === "string" ? output.response : "";
  for (let n = 1; n <= QUESTIONS; n++) {
    const answer = new RegExp(`question\\s*${n}\\s*:\\s*\\[?\\s*(yes|no)\\b`, "i").exec(text);
    if (answer?.[1]?.toLowerCase() !== "no") {
      return {
        verdict: "unsure",
        reason: answer
          ? `flagged for ${CATEGORIES[n - 1]} (question ${n})`
          : `question ${n} was missing or unparseable in the classifier's reply`,
      };
    }
  }
  return { verdict: "clean", reason: null };
}

export function workersAiModerator(ai: AiBinding): Moderator {
  return {
    async check(bytes, _contentType) {
      const output = await ai.run(MODEL, {
        image: Array.from(bytes),
        // Caps the reply length; a truncated reply is read as unsure by parseVerdict.
        prompt: PROMPT,
        max_tokens: 120,
      });
      const { verdict, reason } = parseVerdict(output);
      return { verdict, score: null, reason };
    },
  };
}
