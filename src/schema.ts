/**
 * Defines and parses the two submission types: sectors and objects, and
 * interactions between objects. Exits are computed from adjacency, not
 * submitted. An object names its parent by id.
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { Collector, type ValidationError } from "./errors.ts";

// --- Limits -----------------------------------------------------------------
// These names are also used in docs/ and prompts/.

export const MAX_TITLE_LEN = 64;
export const MAX_SHORT_DESCRIPTION_LEN = 300;
export const MAX_LONG_DESCRIPTION_LEN = 4000;
export const MAX_OBJECT_DESCRIPTION_LEN = 2000;
export const MAX_SUBMISSION_BYTES = 32_768;

/** Max length of an object's `use_text` and an interaction's `text`. */
export const MAX_INTERACTION_TEXT_LEN = 300;

/** Matches only a `/v1/images/<key>` path, as returned by `POST /v1/images`. */
export const IMAGE_URL_PATTERN = /^\/v1\/images\/[A-Za-z0-9_.-]+$/;

// --- Sector -----------------------------------------------------------------

/**
 * One authored sector of the world.
 *
 * `title` is shown on the exit leading to this sector from each neighbour.
 * `shortDescription` is shown from an adjacent sector, before entry.
 * `longDescription` is shown on arrival.
 * `image`, if present, is a URL a prior `POST /v1/images` call returned.
 */
export interface Sector {
  readonly coordinate: Coordinate;
  readonly title: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly image: string | null;
}

/** The wire (snake_case) field names for a sector. */
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
 * An object placed in a sector.
 *
 * `parentId` names either the sector itself or an object already standing
 * in it. `useText`, if given, is shown on `use <this object>`; if absent,
 * `use` falls back to a generic refusal.
 */
export interface ObjectDraft {
  readonly parentId: string;
  readonly title: string;
  readonly description: string;
  readonly useText: string | null;
}

export const OBJECT_FIELDS = ["parent_id", "title", "description", "use_text"] as const;

export function objectDraftAsDict(draft: ObjectDraft): Record<string, unknown> {
  return {
    parent_id: draft.parentId,
    title: draft.title,
    description: draft.description,
    use_text: draft.useText,
  };
}

// --- Interaction --------------------------------------------------------------

/** What a player sees on `use A with B` (or `use B with A`). */
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
// Checks payload shape and types only. Coordinate and parent existence are
// checked in validation.ts.

/** Counts Unicode code points, not UTF-16 code units. */
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
 * Parses the optional `image` field: `undefined` or `null` means no image;
 * otherwise it must match `IMAGE_URL_PATTERN`.
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

/** Parses an optional text field: `undefined` or `null` means no value, otherwise applies `text`'s rules. */
function optionalText(raw: unknown, cap: number, path: string, errors: Collector): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  return text(raw, cap, path, errors);
}

/** Checks whether the JSON-encoded payload exceeds MAX_SUBMISSION_BYTES. */
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

/** Parses an untrusted sector submission, collecting all errors found. */
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
