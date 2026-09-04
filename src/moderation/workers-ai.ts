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
 * moderation entry for the numbers. Two things were found and fixed by that
 * pass, not by reasoning about the model in the abstract: a vague "anything
 * concerning" prompt caught 1 of 3 known-unsafe test images, which is why
 * the prompt below names eight concrete categories and makes the model
 * check each one rather than free-associate; and cost scaled with the
 * input image's resolution far past what recall needed, which is why
 * `Engine.uploadImage` hands this a small classification-only copy rather
 * than the original upload or the stored image.
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

const PROMPT = `You are screening an image before it is shown publicly, unmoderated, on a community world-building platform. Nobody reviews this before it goes live unless you flag it.

Check the image against every one of these 8 categories:
1 nudity/sexual content  2 graphic violence/gore  3 weapons in a threatening context
4 drugs/paraphernalia  5 hate symbols  6 self-harm/suicide  7 a minor in a sexual context
8 anything else disturbing or shocking

Reply with exactly two lines and nothing else:
Line 1: the numbers of every category that applies, comma-separated, or "none"
Line 2: one word, CLEAN or UNSURE

Treat any maybe as a match. Only say CLEAN if line 1 is "none" and you have no doubt at all. A missed unsafe image is far worse than an unnecessary human review, so resolve any uncertainty toward UNSURE.`;

/**
 * The verdict is the reply's *last* line, not its first word — the model is
 * asked to list matching categories before it, and forcing a bare first-word
 * answer is what produced the missed-recall prompt this replaced (see the
 * module comment). Anything other than an unambiguous CLEAN is UNSURE,
 * including a reply this couldn't parse at all: asking a human costs
 * nothing extra, and a false CLEAN is the one mistake this whole feature
 * exists to prevent.
 */
function parseVerdict(output: Record<string, unknown>): Verdict {
  const text = typeof output.response === "string" ? output.response : "";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1) ?? "";
  return /^clean\b/i.test(last) ? "clean" : "unsure";
}

export function workersAiModerator(ai: AiBinding): Moderator {
  return {
    async check(bytes, _contentType) {
      const output = await ai.run(MODEL, {
        image: Array.from(bytes),
        prompt: PROMPT,
        max_tokens: 40,
      });
      return { verdict: parseVerdict(output), score: null };
    },
  };
}
