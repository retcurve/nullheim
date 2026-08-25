/**
 * Shared fixtures for the test suite.
 *
 * The port of `tests/helpers.py`. Kept in `src/` rather than a separate tests
 * tree so the imports are ordinary relative ones and the typechecker sees the
 * fixtures and the code they exercise as one program.
 */

import type { ValidationError } from "./errors.ts";

/** A minimal, valid sector submission at `at`, in wire (snake_case) form. */
export function sector(
  at: readonly [number, number],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    coordinate: [...at],
    title: "A Place",
    short_description: "A doorway, and something past it.",
    long_description: "It is a place, and it is here.",
    ...overrides,
  };
}

/** A minimal, valid object submission hung on `parentId`, in wire form. */
export function obj(
  parentId: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parent_id: parentId,
    title: "A Thing",
    description: "An object of some kind.",
    ...overrides,
  };
}

export function codes(errors: readonly ValidationError[]): Set<string> {
  return new Set(errors.map((error) => error.code));
}
