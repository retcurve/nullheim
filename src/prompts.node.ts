/**
 * Loads the prompt templates from `prompts/` on disk, as plain strings.
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
