/**
 * Semantic validation for a sector, object, or interaction submission: checks
 * ownership and identity against the world's current state.
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { Collector, type ValidationError } from "./errors.ts";
import type { InteractionDraft, ObjectDraft, Sector } from "./schema.ts";

/** Quotes a string in single quotes, escaping backslashes and the quote itself. */
function repr(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** The four store operations `validateSector` and `validateObject` use. */
export interface ValidationStore {
  get(coordinate: Coordinate): { sectorId: string } | null;
  getObject(objectId: string): { coordinate: Coordinate } | null;
  isBaked(coordinate: Coordinate): boolean;
  count(): number;
}

/** Rules for a sector submission. An empty list means it may be baked. */
export function validateSector(
  sector: Sector,
  claimed: Coordinate,
  store: ValidationStore,
): ValidationError[] {
  const errors = new Collector();

  if (!coords.equals(sector.coordinate, claimed)) {
    errors.add(
      "coordinate_mismatch",
      "$.coordinate",
      `submission is for ${coords.toString(sector.coordinate)} but the claim is for ` +
        `${coords.toString(claimed)}`,
    );
    return errors.errors;
  }

  if (!coords.inBounds(sector.coordinate)) {
    errors.add(
      "out_of_bounds",
      "$.coordinate",
      `${coords.toString(sector.coordinate)} is off the lattice`,
    );
  }

  if (store.isBaked(sector.coordinate)) {
    errors.add(
      "already_baked",
      "$.coordinate",
      `${coords.toString(sector.coordinate)} is already part of the world and cannot ` +
        "be rewritten",
    );
  }

  // Checks that the coordinate touches at least one already-baked neighbour.
  const touchesWorld = coords
    .neighbours(sector.coordinate)
    .some(([, neighbour]) => store.isBaked(neighbour));
  if (store.count() && !touchesWorld) {
    errors.add(
      "orphan_sector",
      "$.coordinate",
      `${coords.toString(sector.coordinate)} touches no existing sector, so no player ` +
        "could ever reach it",
    );
  }

  return errors.errors;
}

/**
 * Rules for an object submission. `parentId` must name a sector, or an
 * object inside a sector, that already exists among the given
 * `sectorCoordinates`.
 */
export function validateObject(
  draft: ObjectDraft,
  sectorCoordinates: readonly Coordinate[],
  store: ValidationStore,
): ValidationError[] {
  const errors = new Collector();

  if (!draft.parentId) {
    // Empty parentId is already reported elsewhere as a type_error.
    return errors.errors;
  }

  for (const coordinate of sectorCoordinates) {
    const baked = store.get(coordinate);
    if (baked !== null && draft.parentId === baked.sectorId) {
      return errors.errors; // parentId names one of the caller's own sectors
    }
  }

  const parent = store.getObject(draft.parentId);
  if (parent === null) {
    errors.add(
      "no_such_parent",
      "$.parent_id",
      `there is no object or sector ${repr(draft.parentId)} in the world`,
    );
  } else if (!sectorCoordinates.some((c) => coords.equals(parent.coordinate, c))) {
    // Uses the same message as a missing parent, for an object that exists
    // but stands in a sector the caller does not hold.
    errors.add(
      "no_such_parent",
      "$.parent_id",
      `there is no object ${repr(draft.parentId)} in your sector`,
    );
  }

  return errors.errors;
}

/** The two store operations `validateInteraction` uses. */
export interface InteractionValidationStore {
  getObject(objectId: string): { coordinate: Coordinate } | null;
  interactionExists(objectAId: string, objectBId: string): boolean;
}

/**
 * Rules for an interaction submission. Both objects must already exist,
 * both must stand in the same sector, that sector must be one of
 * `sectorCoordinates`, and this pair must not already have an interaction.
 */
export function validateInteraction(
  draft: InteractionDraft,
  sectorCoordinates: readonly Coordinate[],
  store: InteractionValidationStore,
): ValidationError[] {
  const errors = new Collector();

  if (!draft.objectAId || !draft.objectBId) {
    // Empty ids are already reported elsewhere.
    return errors.errors;
  }

  if (draft.objectAId === draft.objectBId) {
    errors.add(
      "same_object",
      "$.object_b_id",
      "an object cannot be used with itself",
    );
    return errors.errors;
  }

  const a = store.getObject(draft.objectAId);
  const b = store.getObject(draft.objectBId);
  if (a === null || !sectorCoordinates.some((c) => coords.equals(a.coordinate, c))) {
    errors.add(
      "no_such_object",
      "$.object_a_id",
      `there is no object ${repr(draft.objectAId)} in your sector`,
    );
  }
  if (b === null || !sectorCoordinates.some((c) => coords.equals(b.coordinate, c))) {
    errors.add(
      "no_such_object",
      "$.object_b_id",
      `there is no object ${repr(draft.objectBId)} in your sector`,
    );
  }
  if (errors.errors.length) {
    return errors.errors;
  }

  if (!coords.equals(a!.coordinate, b!.coordinate)) {
    errors.add(
      "different_sectors",
      "$.object_b_id",
      "both objects must stand in the same sector",
    );
    return errors.errors;
  }

  if (store.interactionExists(draft.objectAId, draft.objectBId)) {
    errors.add(
      "interaction_exists",
      "$",
      `these two objects already have an interaction and it cannot be replaced`,
    );
  }

  return errors.errors;
}
