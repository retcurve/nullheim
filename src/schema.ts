/**
 * The submission schemas — the single source of truth for the contract.
 *
 * Agents submit two kinds of thing, and both are almost entirely free text.
 * There is no structural payload left for an agent to get wrong: exits are
 * derived from adjacency by the engine, not declared, and an object's place in
 * the world is a single parent reference.
 *
 * The docs and the prompt templates are written from this module;
 * `drift.test.ts` asserts they still agree with it.
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { Collector, type ValidationError } from "./errors.ts";

// --- Limits -----------------------------------------------------------------
// Referenced by name in docs/ and prompts/.

export const MAX_TITLE_LEN = 64;
export const MAX_SHORT_DESCRIPTION_LEN = 300;
export const MAX_LONG_DESCRIPTION_LEN = 4000;
export const MAX_OBJECT_DESCRIPTION_LEN = 2000;
export const MAX_SUBMISSION_BYTES = 32_768;

/**
 * The one line shown for a `use` command — an object's own `use_text` and an
 * interaction's `text` both cap here. Short on purpose: this is a single
 * beat of flavour text triggered by a command, not a second description.
 */
export const MAX_INTERACTION_TEXT_LEN = 300;

/**
 * The exact shape `POST /v1/images` hands back, and the only shape `image`
 * accepts here — never an arbitrary external URL. This is a structural
 * check only: it does not confirm the id was ever actually issued, the same
 * "narrow on purpose" reasoning `validation.ts` gives for not growing what
 * it can ask the store — a forged id just fails to load client-side.
 */
export const IMAGE_URL_PATTERN = /^\/v1\/images\/[A-Za-z0-9_.-]+$/;

// --- Sector -----------------------------------------------------------------

/**
 * One authored sector of the world.
 *
 * The three texts do three different jobs, and an agent that confuses them
 * produces a room that reads wrong from next door:
 *
 * `title` is not just a name — it is the label a player sees on the exit
 * leading here from every adjacent sector. It has to work as a signpost read
 * from outside.
 *
 * `shortDescription` is seen from an adjacent sector, before the player has
 * entered — a glimpse through the doorway, not a summary of the room. It
 * should only hint at what `longDescription` reveals in full on arrival.
 *
 * `longDescription` is the room itself, shown on arrival.
 *
 * `image`, if present, must be a URL a prior `POST /v1/images` call
 * returned, and is fixed at creation like everything else here — there is
 * no way to attach or replace one on a sector that already exists.
 */
export interface Sector {
  readonly coordinate: Coordinate;
  readonly title: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly image: string | null;
}

/**
 * The wire spelling is snake_case and is part of the agent-facing contract; the
 * TypeScript spelling is camelCase. This module is the only place the two meet,
 * so the boundary is one function wide in each direction.
 */
export const SECTOR_FIELDS = [
  "coordinate",
  "title",
  "short_description",
  "long_description",
  "image",
] as const;

export function sectorAsDict(sector: Sector): Record<string, unknown> {
  return {
    coordinate: coords.asList(sector.coordinate),
    title: sector.title,
    short_description: sector.shortDescription,
    long_description: sector.longDescription,
    image: sector.image,
  };
}

// --- Object -----------------------------------------------------------------

/**
 * An object an agent wants to hang somewhere in its sector.
 *
 * `parentId` is required and always names something that must already exist:
 * either the sector's own id (to stand the object in the sector itself) or an
 * object already standing in that sector. Because a parent must already exist,
 * the object graph is a tree by construction — there is no cycle to guard
 * against.
 *
 * `image` follows the same rule as a sector's: a URL from a prior
 * `POST /v1/images` call, fixed at creation.
 *
 * `useText`, if given, is what a player sees on `use <this object>` — fixed
 * at creation like everything else here, since an object can never be
 * rewritten. Absent means `use` on it falls back to a generic refusal. A
 * *combination* of two objects (`use A with B`) is a separate, later-authored
 * thing — see `InteractionDraft` below — because it necessarily needs both
 * objects to already exist.
 */
export interface ObjectDraft {
  readonly parentId: string;
  readonly title: string;
  readonly description: string;
  readonly image: string | null;
  readonly useText: string | null;
}

export const OBJECT_FIELDS = ["parent_id", "title", "description", "image", "use_text"] as const;

export function objectDraftAsDict(draft: ObjectDraft): Record<string, unknown> {
  return {
    parent_id: draft.parentId,
    title: draft.title,
    description: draft.description,
    image: draft.image,
    use_text: draft.useText,
  };
}

// --- Interaction --------------------------------------------------------------

/**
 * What a player sees on `use A with B` (or `use B with A` — order never
 * matters). Both objects must already exist and must stand in the same
 * sector, and only that sector's own holder may author one, the same rule
 * that already governs who may add an object to it. Written once: like
 * everything else here, a given pair of objects gets exactly one
 * interaction, permanently.
 */
export interface InteractionDraft {
  readonly objectAId: string;
  readonly objectBId: string;
  readonly text: string;
}

export const INTERACTION_FIELDS = ["object_a_id", "object_b_id", "text"] as const;

export function interactionDraftAsDict(draft: InteractionDraft): Record<string, unknown> {
  return {
    object_a_id: draft.objectAId,
    object_b_id: draft.objectBId,
    text: draft.text,
  };
}

// --- Parsing ----------------------------------------------------------------
//
// Parsing is structural only: it proves the payload has the right shape and
// types. Whether a coordinate is the one you claimed, or a parent really exists,
// is decided in validation.ts.

/**
 * Length in code points, not UTF-16 code units.
 *
 * `"𝔊".length` is 2 in JavaScript and 1 in Python. Using the bare `.length`
 * here would silently halve the real limit for any agent writing outside the
 * BMP — emoji, older scripts, mathematical alphanumerics — and reject text
 * Python accepted. The limits are documented in characters, so characters is
 * what they must count.
 */
function codePointLength(value: string): number {
  return [...value].length;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function text(raw: unknown, cap: number, path: string, errors: Collector): string {
  if (typeof raw !== "string") {
    errors.add("type_error", path, "expected a string");
    return "";
  }
  if (!raw.trim()) {
    errors.add("empty_text", path, "must not be blank");
    return raw;
  }
  const length = codePointLength(raw);
  if (length > cap) {
    errors.add("too_long", path, `must be at most ${cap} characters (got ${length})`);
  }
  for (const ch of raw) {
    const point = ch.codePointAt(0)!;
    if (point < 32 && ch !== "\n" && ch !== "\t") {
      errors.add("control_characters", path, "must not contain control characters");
      break;
    }
  }
  return raw;
}

/**
 * Reject a payload too large to be a good-faith submission.
 *
 * Measured on `JSON.stringify`'s compact form (no separators between fields),
 * not a padded one — a representative sector measures 99 bytes this way. The
 * threshold is an arbitrary sanity bound and nothing sits near it, so the exact
 * encoding doesn't matter.
 */
/**
 * `image` is the one optional field on either submission: absent (or
 * explicitly `null`) is fine and means no image, present means it must
 * match what `POST /v1/images` hands back.
 */
function image(raw: unknown, path: string, errors: Collector): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string" || !IMAGE_URL_PATTERN.test(raw)) {
    errors.add(
      "invalid_image",
      path,
      "must be a url a prior POST /v1/images call returned, or omitted entirely",
    );
    return null;
  }
  return raw;
}

/**
 * The other optional field besides `image`: absent (or explicitly `null`)
 * means nothing, present means it must pass the same text rules as any
 * other field of the given cap — non-blank, no control characters.
 */
function optionalText(raw: unknown, cap: number, path: string, errors: Collector): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  return text(raw, cap, path, errors);
}

function oversized(raw: unknown, errors: Collector): boolean {
  const encoded = new TextEncoder().encode(JSON.stringify(raw) ?? "").length;
  if (encoded > MAX_SUBMISSION_BYTES) {
    errors.add(
      "too_large",
      "$",
      `submission must serialise to at most ${MAX_SUBMISSION_BYTES} bytes (got ${encoded})`,
    );
    return true;
  }
  return false;
}

function unknownFields(raw: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(raw)
    .filter((field) => !known.includes(field))
    .sort();
}

export interface ParseResult<T> {
  readonly parsed: T | null;
  readonly errors: ValidationError[];
}

/**
 * Structurally parse an untrusted sector submission.
 *
 * Every problem found is reported at once, so an agent never has to resubmit to
 * discover the next one.
 */
export function parseSector(raw: unknown): ParseResult<Sector> {
  const errors = new Collector();

  if (!isPlainObject(raw)) {
    errors.add("type_error", "$", "a sector must be a JSON object");
    return { parsed: null, errors: errors.errors };
  }
  if (oversized(raw, errors)) {
    return { parsed: null, errors: errors.errors };
  }

  const unknown = unknownFields(raw, SECTOR_FIELDS);
  if (unknown.length) {
    errors.add("unknown_field", "$", `unrecognised fields: ${unknown.join(", ")}`);
  }

  let coordinate: Coordinate;
  try {
    coordinate = coords.parse(raw["coordinate"]);
  } catch (exc) {
    errors.add("type_error", "$.coordinate", (exc as Error).message);
    return { parsed: null, errors: errors.errors };
  }

  const sector: Sector = {
    coordinate,
    title: text(raw["title"], MAX_TITLE_LEN, "$.title", errors),
    shortDescription: text(
      raw["short_description"],
      MAX_SHORT_DESCRIPTION_LEN,
      "$.short_description",
      errors,
    ),
    longDescription: text(
      raw["long_description"],
      MAX_LONG_DESCRIPTION_LEN,
      "$.long_description",
      errors,
    ),
    image: image(raw["image"], "$.image", errors),
  };
  return { parsed: sector, errors: errors.errors };
}

/** Structurally parse an untrusted object submission. */
export function parseObject(raw: unknown): ParseResult<ObjectDraft> {
  const errors = new Collector();

  if (!isPlainObject(raw)) {
    errors.add("type_error", "$", "an object must be a JSON object");
    return { parsed: null, errors: errors.errors };
  }
  if (oversized(raw, errors)) {
    return { parsed: null, errors: errors.errors };
  }

  const unknown = unknownFields(raw, OBJECT_FIELDS);
  if (unknown.length) {
    errors.add("unknown_field", "$", `unrecognised fields: ${unknown.join(", ")}`);
  }

  let parentId = raw["parent_id"];
  if (typeof parentId !== "string" || !parentId.trim()) {
    errors.add(
      "type_error",
      "$.parent_id",
      "required: this sector's own id (to stand the object in the sector " +
        "itself), or the id of an object already in it",
    );
    parentId = "";
  }

  const draft: ObjectDraft = {
    parentId: parentId as string,
    title: text(raw["title"], MAX_TITLE_LEN, "$.title", errors),
    description: text(
      raw["description"],
      MAX_OBJECT_DESCRIPTION_LEN,
      "$.description",
      errors,
    ),
    image: image(raw["image"], "$.image", errors),
    useText: optionalText(raw["use_text"], MAX_INTERACTION_TEXT_LEN, "$.use_text", errors),
  };
  return { parsed: draft, errors: errors.errors };
}

/** Structurally parse an untrusted interaction submission. */
export function parseInteraction(raw: unknown): ParseResult<InteractionDraft> {
  const errors = new Collector();

  if (!isPlainObject(raw)) {
    errors.add("type_error", "$", "an interaction must be a JSON object");
    return { parsed: null, errors: errors.errors };
  }
  if (oversized(raw, errors)) {
    return { parsed: null, errors: errors.errors };
  }

  const unknown = unknownFields(raw, INTERACTION_FIELDS);
  if (unknown.length) {
    errors.add("unknown_field", "$", `unrecognised fields: ${unknown.join(", ")}`);
  }

  let objectAId = raw["object_a_id"];
  if (typeof objectAId !== "string" || !objectAId.trim()) {
    errors.add("type_error", "$.object_a_id", "required: the id of an object in your sector");
    objectAId = "";
  }

  let objectBId = raw["object_b_id"];
  if (typeof objectBId !== "string" || !objectBId.trim()) {
    errors.add(
      "type_error",
      "$.object_b_id",
      "required: the id of a different object in the same sector",
    );
    objectBId = "";
  }

  const draft: InteractionDraft = {
    objectAId: objectAId as string,
    objectBId: objectBId as string,
    text: text(raw["text"], MAX_INTERACTION_TEXT_LEN, "$.text", errors),
  };
  return { parsed: draft, errors: errors.errors };
}
