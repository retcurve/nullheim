/**
 * Semantic validation — the gate between a well-formed payload and the world.
 *
 * There is very little left to check, and that is the design working rather than
 * a gap. Exits are derived from adjacency instead of declared, so there are no
 * borders to disagree about. An object's parent must already exist, so the
 * object graph is a tree by construction and there is no cycle to hunt for.
 *
 * What remains is ownership and identity: is this the sector you claimed, and is
 * that parent really yours?
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { Collector, type ValidationError } from "./errors.ts";
import type { InteractionDraft, ObjectDraft, Sector } from "./schema.ts";

/**
 * Quote a string in single quotes, escaping backslashes and the quote itself.
 *
 * Used by the two `no_such_parent` messages below to quote an agent-supplied id.
 */
function repr(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * The slice of the store validation actually needs.
 *
 * Narrow on purpose: validation asks four questions and must not grow the
 * ability to ask more. Python passed the whole store and relied on discipline.
 */
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

  // Allocation only ever hands out coordinates touching the existing world, so
  // this should be unreachable. It is asserted anyway: an orphan sector would be
  // permanently unreachable by players and impossible to repair.
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
 * Rules for an object submission.
 *
 * `parentId` is required and must name something that already exists in one of
 * this agent's own sectors: either a sector's own id, or an object standing in
 * one of them. Both checks are really the same one: an agent may furnish the
 * rooms it built and nobody else's.
 *
 * `parentId` is also what *selects* the sector — an agent holding several is
 * never asked which one it means, because the parent already says.
 */
export function validateObject(
  draft: ObjectDraft,
  sectorCoordinates: readonly Coordinate[],
  store: ValidationStore,
): ValidationError[] {
  const errors = new Collector();

  if (!draft.parentId) {
    // parseObject already reported this as a type_error; piling on a
    // no_such_parent for the empty string it fell back to is just noise.
    return errors.errors;
  }

  for (const coordinate of sectorCoordinates) {
    const baked = store.get(coordinate);
    if (baked !== null && draft.parentId === baked.sectorId) {
      return errors.errors; // hanging it on a sector of your own is always fine
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
    // Deliberately the same message as a missing parent. An agent has no
    // business learning what stands in somebody else's sector.
    errors.add(
      "no_such_parent",
      "$.parent_id",
      `there is no object ${repr(draft.parentId)} in your sector`,
    );
  }

  return errors.errors;
}

/**
 * The slice of the store `validateInteraction` needs — its own narrow
 * facade rather than a growth of `ValidationStore` above, the same "ask
 * only what this form needs" discipline applied per form rather than
 * globally.
 */
export interface InteractionValidationStore {
  getObject(objectId: string): { coordinate: Coordinate } | null;
  interactionExists(objectAId: string, objectBId: string): boolean;
}

/**
 * Rules for an interaction submission.
 *
 * Both objects must already exist, both must stand in the same sector, and
 * that sector must be one of the caller's own — exactly the ownership check
 * `validateObject` applies to a single object, since every object in a
 * sector was necessarily placed by whoever holds it. A pair may only ever
 * get one interaction: like a sector or an object, once written it cannot
 * be replaced.
 */
export function validateInteraction(
  draft: InteractionDraft,
  sectorCoordinates: readonly Coordinate[],
  store: InteractionValidationStore,
): ValidationError[] {
  const errors = new Collector();

  if (!draft.objectAId || !draft.objectBId) {
    // parseInteraction already reported this; piling on for the empty
    // string either fell back to is just noise.
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
