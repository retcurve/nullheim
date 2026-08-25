/**
 * Semantic rules: identity, ownership, and reachability.
 *
 * There is far less here than the border-contract design needed, and that is the
 * point of deriving exits from adjacency — most of what used to be checkable is
 * now unrepresentable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ORIGIN, coord, type Coordinate } from "./coords.ts";
import type { Engine } from "./engine.ts";
import type { ValidationError } from "./errors.ts";
import { parseObject, parseSector } from "./schema.ts";
import { validateObject, validateSector, type ValidationStore } from "./validation.ts";
import { codes, makeEngine, obj, root, sector, settle } from "./testing.ts";

function storeView(engine: Engine): ValidationStore {
  return {
    get: (c: Coordinate) => engine.store.get(c),
    getObject: (id: string) => engine.store.getObject(id),
    isBaked: (c: Coordinate) => engine.store.isBaked(c),
    count: () => engine.store.count(),
  };
}

function checkSector(engine: Engine, at: Coordinate, payload: unknown): ValidationError[] {
  const { parsed, errors } = parseSector(payload);
  if (parsed === null) {
    return errors;
  }
  return [...errors, ...validateSector(parsed, at, storeView(engine))];
}

function checkObject(engine: Engine, at: Coordinate, payload: unknown): ValidationError[] {
  const { parsed, errors } = parseObject(payload);
  if (parsed === null) {
    return errors;
  }
  return [...errors, ...validateObject(parsed, at, storeView(engine))];
}

describe("sector rules", () => {
  test("a valid sector passes", () => {
    const engine = makeEngine();
    assert.deepEqual(checkSector(engine, coord(0, 1), sector([0, 1])), []);
  });

  test("a submission must match the claimed coordinate", () => {
    const engine = makeEngine();
    const errors = checkSector(engine, coord(0, 1), sector([5, 5]));
    assert.ok(codes(errors).has("coordinate_mismatch"));
  });

  test("a mismatched coordinate suppresses the other rules", () => {
    // Reporting orphan/adjacency errors about the wrong square is noise.
    const engine = makeEngine();
    const errors = checkSector(engine, coord(0, 1), sector([900, 900]));
    assert.deepEqual(codes(errors), new Set(["coordinate_mismatch"]));
  });

  test("a taken coordinate is refused", () => {
    const engine = makeEngine();
    const errors = checkSector(engine, ORIGIN, sector([0, 0]));
    assert.ok(codes(errors).has("already_baked"));
  });

  test("a sector touching nothing is refused", () => {
    // Allocation cannot produce this, but an orphan would be unreachable.
    const engine = makeEngine();
    const errors = checkSector(engine, coord(40, 40), sector([40, 40]));
    assert.ok(codes(errors).has("orphan_sector"));
  });

  test("touching the world on any single side is enough", () => {
    const engine = makeEngine();
    for (const at of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      assert.deepEqual(
        checkSector(engine, coord(at[0], at[1]), sector(at)),
        [],
        `${JSON.stringify(at)} should be buildable`,
      );
    }
  });

  test("a coordinate off the lattice is refused", () => {
    const engine = makeEngine();
    const far = [1025, 0] as const;
    const errors = checkSector(engine, coord(1025, 0), sector(far));
    assert.ok(codes(errors).has("out_of_bounds"));
  });
});

describe("object rules", () => {
  test("hanging an object on the sector is always fine", () => {
    const engine = makeEngine();
    const genesisId = engine.store.get(ORIGIN)!.sectorId;
    assert.deepEqual(checkObject(engine, ORIGIN, obj(genesisId)), []);
  });

  test("a null parent id is refused", () => {
    // null used to mean the sector itself; the sector's own id does now.
    const engine = makeEngine();
    const errors = checkObject(engine, ORIGIN, obj(null));
    assert.ok(codes(errors).has("type_error"));
  });

  test("a parent that does not exist is refused", () => {
    const engine = makeEngine();
    const errors = checkObject(engine, ORIGIN, obj("obj_nope"));
    assert.ok(codes(errors).has("no_such_parent"));
  });

  test("an object may hang on another object in the same sector", () => {
    const engine = makeEngine();
    const { agent } = settle(engine);
    const { object: first, errors } = engine.createObject(agent, obj(root(engine, agent)));
    assert.deepEqual(errors, []);
    assert.deepEqual(checkObject(engine, agent.coordinate!, obj(first!.objectId)), []);
  });

  test("an object in another agent's sector is not a valid parent", () => {
    const engine = makeEngine();
    const { agent: one } = settle(engine, "one");
    const { agent: two } = settle(engine, "two");
    const { object: theirs } = engine.createObject(one, obj(root(engine, one)));

    const errors = checkObject(engine, two.coordinate!, obj(theirs!.objectId));
    assert.ok(codes(errors).has("no_such_parent"));
  });

  test("someone else's object is indistinguishable from a missing one", () => {
    // An agent has no business learning what stands in another sector.
    const engine = makeEngine();
    const { agent: one } = settle(engine, "one");
    const { agent: two } = settle(engine, "two");
    const { object: theirs } = engine.createObject(
      one,
      obj(root(engine, one), { title: "Their Secret Thing" }),
    );

    const trespass = checkObject(engine, two.coordinate!, obj(theirs!.objectId));
    const missing = checkObject(engine, two.coordinate!, obj("obj_deadbeefdeadbeef"));
    assert.deepEqual(codes(trespass), codes(missing));
    assert.ok(!trespass[0]!.message.includes("Their Secret Thing"));
  });

  test("the object graph cannot cycle", () => {
    // A parent must already exist, so a cycle is unrepresentable.
    const engine = makeEngine();
    const { agent } = settle(engine);
    const { object: first } = engine.createObject(
      agent,
      obj(root(engine, agent), { title: "Crate" }),
    );
    const { object: second } = engine.createObject(
      agent,
      obj(first!.objectId, { title: "Tin" }),
    );

    // The only way to close a loop would be to repoint an existing object, and
    // nothing in the API can do that.
    assert.equal(second!.parentId, first!.objectId);
    assert.equal(engine.store.getObject(first!.objectId)!.parentId, null);
  });
});
