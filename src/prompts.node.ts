/**
 * The prompt templates, read from `prompts/` on disk.
 *
 * Node-only: `Engine` takes its prompts as plain strings at construction
 * (see `engine.ts`) precisely so nothing in the shared core has to know how
 * they got there. The Workers build gets the same two files a different way
 * — bundled in by `wrangler`'s text-module rule, see `worker.ts` — because
 * there is no filesystem to read at request time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PromptTemplates } from "./engine.ts";

const PROMPT_DIR = join(import.meta.dirname, "..", "prompts");

export function loadPrompts(): PromptTemplates {
  return {
    sector_architect: readFileSync(join(PROMPT_DIR, "sector_architect.md"), "utf-8"),
    object_artisan: readFileSync(join(PROMPT_DIR, "object_artisan.md"), "utf-8"),
  };
}
