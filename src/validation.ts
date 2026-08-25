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
import type { ObjectDraft, Sector } from "./schema.ts";

/**
 * Render a string the way Python's `repr()` would: single quotes.
 *
 * The two `no_such_parent` messages below interpolate an agent-supplied id, and
 * Python spelled it with `!r`. Matching that exactly means the differential
 * harness in the port's final phase can compare messages verbatim instead of
 * carrying a whitelist for quote style.
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
 * `parentId` is required and must name something that already exists in this
 * agent's own sector: either the sector's own id, or an object standing in it.
 * Both checks are really the same one: an agent may furnish its own room and
 * nobody else's.
 */
export function validateObject(
  draft: ObjectDraft,
  sectorCoordinate: Coordinate,
  store: ValidationStore,
): ValidationError[] {
  const errors = new Collector();

  if (!draft.parentId) {
    // parseObject already reported this as a type_error; piling on a
    // no_such_parent for the empty string it fell back to is just noise.
    return errors.errors;
  }

  const baked = store.get(sectorCoordinate);
  if (baked !== null && draft.parentId === baked.sectorId) {
    return errors.errors; // hanging it on the sector itself is always fine
  }

  const parent = store.getObject(draft.parentId);
  if (parent === null) {
    errors.add(
      "no_such_parent",
      "$.parent_id",
      `there is no object or sector ${repr(draft.parentId)} in the world`,
    );
  } else if (!coords.equals(parent.coordinate, sectorCoordinate)) {
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
