/**
 * The real classifier: a vision-language chat model behind Cloudflare
 * Workers AI, prompted to answer a moderation judgement directly rather than
 * a calibrated score — see `../moderation.ts`'s module comment for why the
 * `score` field on the result stays null here.
 *
 * `MODEL` was chosen after checking Workers AI's catalogue directly:
 * there is no purpose-built image-moderation classifier there (2026-09), so
 * this is a general vision-language chat model prompted for a judgement, not
 * something benchmarked for this job by its authors. Nothing outside this
 * file names it, so swapping it is a one-line change.
 *
 * This one's rights are gated by Meta's Llama 3.2 Community License, which
 * withholds the multimodal-model grant specifically (not the text-only
 * grant) from anyone domiciled in, or with a principal place of business
 * in, the EU — see CLAUDE.md's moderation entry before deploying this to an
 * account that might be. The model also refuses every call until one
 * initial request with `{"prompt": "agree"}` has been sent to it from the
 * account calling it, once, ever — a Cloudflare account requirement, not
 * something this code can do on an account's behalf.
 *
 * The prompt, `MAX_CLASSIFICATION_WIDTH` and `max_tokens` below were all
 * measured directly against a live account, not assumed — see CLAUDE.md's
 * moderation entry for the numbers. Three things were found and fixed by
 * those passes, not by reasoning about the model in the abstract: a vague
 * "anything concerning" prompt caught 1 of 3 known-unsafe test images,
 * which is why the prompt below names eight concrete categories and makes
 * the model check each one rather than free-associate; cost scaled with the
 * input image's resolution far past what recall needed, which is why
 * `Engine.uploadImage` hands this a small classification-only copy rather
 * than the original upload or the stored image; and asking for a *verdict*
 * on those categories made the model hedge instead of answer, which is why
 * it is now asked eight Yes/No questions about what is visible — see the
 * comment on `PROMPT`.
 *
 * `AiBinding` is this file's own minimal shape rather than the ambient `Ai`
 * type Workers ships (see `worker-env.d.ts`'s neighbours for that pattern):
 * `Ai.run` is overloaded per known model name with a per-model input/output
 * type, and asking for that overload here would assert a schema this file
 * only knows empirically, from probing the live endpoint directly, not from
 * Workers AI's own generated types. `worker.ts` adapts `env.AI` to this
 * shape with a plain wrapper closure, which sidesteps the question of
 * whether the two types are structurally assignable at all.
 */

import type { Moderator, Verdict } from "../moderation.ts";

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * One question per category, answered Yes/No, rather than a single verdict
 * token. The shape is the load-bearing part, not the wording: asked for a
 * verdict on whether an image is fit to publish, this model hedges instead
 * of answering — measured 2026-09-04, five runs against a bakery interior
 * (dough, honey jars, a sleeping cat) that is clean by any reading, and not
 * one produced a parseable verdict. It answered "I'm unable to classify the
 * image against the given categories", and, on the same picture, "a cat in a
 * potentially unsafe environment". All five parsed as UNSURE.
 *
 * The prompt this replaced supplied the anxiety itself — it opened by
 * telling the model the image would go out unmoderated and that nobody
 * would review it unless it flagged it, which is true, and which turns
 * every answer into a publishing decision the model then declines to make.
 * Asking instead what is *visible in the picture* is a question about the
 * image rather than about consequences, and it is answered: the same five
 * runs returned "No" eight times, byte-identical, every time.
 *
 * The category list is unchanged from that prompt — all eight survive, in
 * the same order. A three-question version was tried first and works
 * equally well, but there is nothing to buy with the coverage it drops:
 * eight questions cost 10.8 neurons against the old prompt's 10-12, so
 * the wider screen is free.
 */
const PROMPT = `Perform a sterile inspection of this visual media. Answer the following questions with only a 'Yes' or 'No'. Do not provide explanations or summaries.

1. Does this image contain any visible blood, physical injuries, or weapons?
2. Does this image contain any depictions of nudity or explicit romantic context?
3. Does this image contain any text or typography featuring vulgar language?
4. Does this image contain any depiction of drugs or drug paraphernalia?
5. Does this image contain any hate symbols or extremist insignia?
6. Does this image depict self-harm or suicide?
7. Does this image depict a child in any sexualised way?
8. Is there anything else in this image a general audience would find disturbing?

Format your response exactly like this, one line per question:
Question 1: [Yes/No]
Question 2: [Yes/No]
Question 3: [Yes/No]
Question 4: [Yes/No]
Question 5: [Yes/No]
Question 6: [Yes/No]
Question 7: [Yes/No]
Question 8: [Yes/No]`;

const QUESTIONS = 8;

/**
 * Clean requires all eight questions answered, and all eight answered No.
 * Every other reading is UNSURE — a Yes, a missing question, a line this
 * couldn't parse, an answer that is neither word, or a refusal, which
 * arrives as prose matching nothing here and so needs no case of its own.
 * Silence is never consent: a reply that says less than expected says
 * nothing about what it left out. Asking a human costs nothing extra, and
 * a false CLEAN is the one mistake this whole feature exists to prevent.
 *
 * Each answer is found by its own question number rather than by reading
 * lines in order, so extra prose around them cannot shift the mapping and
 * make one question's answer stand in for another's.
 */
function parseVerdict(output: Record<string, unknown>): Verdict {
  const text = typeof output.response === "string" ? output.response : "";
  for (let n = 1; n <= QUESTIONS; n++) {
    const answer = new RegExp(`question\\s*${n}\\s*:\\s*\\[?\\s*(yes|no)\\b`, "i").exec(text);
    if (answer?.[1]?.toLowerCase() !== "no") return "unsure";
  }
  return "clean";
}

export function workersAiModerator(ai: AiBinding): Moderator {
  return {
    async check(bytes, _contentType) {
      const output = await ai.run(MODEL, {
        image: Array.from(bytes),
        // Eight answer lines need roughly 90 tokens; the ceiling is not a
        // budget to tune but a stop for a model that started narrating.
        // Truncating an answer line costs a CLEAN, never buys a false one —
        // `parseVerdict` reads a missing question as UNSURE.
        prompt: PROMPT,
        max_tokens: 120,
      });
      return { verdict: parseVerdict(output), score: null };
    },
  };
}
