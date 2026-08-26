/**
 * Semantic rules: identity, ownership, and reachability.
 *
 * There is far less here than the border-contract design needed, and that is the
 * point of deriving exits from adjacency — most of what used to be checkable is
 * now unrepresentable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as coords from "./coords.ts";
import { ORIGIN, coord, type Coordinate } from "./coords.ts";
import type { Engine } from "./engine.ts";
import type { ValidationError } from "./errors.ts";
import { parseObject, parseSector } from "./schema.ts";
import { validateObject, validateSector, type ValidationStore } from "./validation.ts";
import { codes, makeEngine, obj, root, sector, settle } from "./testing.ts";

/**
 * A synchronous facade over the live store, built by prefetching exactly what
 * `validateSector`/`validateObject` can ask for — the same two-phase shape
 * `engine.ts`'s own `#sectorValidationStore`/`#objectValidationStore` use.
 * `validation.ts` itself stays synchronous, so anything feeding it has to be.
 */
async function checkSector(engine: Engine, at: Coordinate, payload: unknown): Promise<ValidationError[]> {
  const { parsed, errors } = parseSector(payload);
  if (parsed === null) {
    return errors;
  }
  const checked = [parsed.coordinate, ...coords.neighbours(parsed.coordinate).map(([, n]) => n)];
  const [flags, count] = await Promise.all([
    Promise.all(checked.map((c) => engine.store.isBaked(c))),
    engine.store.count(),
  ]);
  const baked = new Map(checked.map((c, i) => [coords.key(c), flags[i]!]));
  const store: ValidationStore = {
    isBaked: (c) => baked.get(coords.key(c)) ?? false,
    get: () => null, // unused by validateSector
    getObject: () => null, // unused by validateSector
    count: () => count,
  };
  return [...errors, ...validateSector(parsed, at, store)];
}

/** `at` is the one sector under test; validateObject itself takes the whole estate. */
async function checkObject(engine: Engine, at: Coordinate, payload: unknown): Promise<ValidationError[]> {
  const { parsed, errors } = parseObject(payload);
  if (parsed === null) {
    return errors;
  }
  const [atSector, parent] = await Promise.all([
    engine.store.get(at),
    engine.store.getObject(parsed.parentId),
  ]);
  const store: ValidationStore = {
    isBaked: () => false, // unused by validateObject
    get: (c) => (coords.equals(c, at) ? atSector : null),
    getObject: (id) => (id === parsed.parentId ? parent : null),
    count: () => 0, // unused by validateObject
  };
  return [...errors, ...validateObject(parsed, [at], store)];
}

describe("sector rules", () => {
  test("a valid sector passes", async () => {
    const { engine } = await makeEngine();
    assert.deepEqual(await checkSector(engine, coord(0, 1), sector([0, 1])), []);
  });

  test("a submission must match the claimed coordinate", async () => {
    const { engine } = await makeEngine();
    const errors = await checkSector(engine, coord(0, 1), sector([5, 5]));
    assert.ok(codes(errors).has("coordinate_mismatch"));
  });

  test("a mismatched coordinate suppresses the other rules", async () => {
    // Reporting orphan/adjacency errors about the wrong square is noise.
    const { engine } = await makeEngine();
    const errors = await checkSector(engine, coord(0, 1), sector([900, 900]));
    assert.deepEqual(codes(errors), new Set(["coordinate_mismatch"]));
  });

  test("a taken coordinate is refused", async () => {
    const { engine } = await makeEngine();
    const errors = await checkSector(engine, ORIGIN, sector([0, 0]));
    assert.ok(codes(errors).has("already_baked"));
  });

  test("a sector touching nothing is refused", async () => {
    // Allocation cannot produce this, but an orphan would be unreachable.
    const { engine } = await makeEngine();
    const errors = await checkSector(engine, coord(40, 40), sector([40, 40]));
    assert.ok(codes(errors).has("orphan_sector"));
  });

  test("touching the world on any single side is enough", async () => {
    const { engine } = await makeEngine();
    for (const at of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      assert.deepEqual(
        await checkSector(engine, coord(at[0], at[1]), sector(at)),
        [],
        `${JSON.stringify(at)} should be buildable`,
      );
    }
  });

  test("a coordinate off the lattice is refused", async () => {
    const { engine } = await makeEngine();
    const far = [1025, 0] as const;
    const errors = await checkSector(engine, coord(1025, 0), sector(far));
    assert.ok(codes(errors).has("out_of_bounds"));
  });
});

describe("object rules", () => {
  test("hanging an object on the sector is always fine", async () => {
    const { engine } = await makeEngine();
    const genesisId = (await engine.store.get(ORIGIN))!.sectorId;
    assert.deepEqual(await checkObject(engine, ORIGIN, obj(genesisId)), []);
  });

  test("a null parent id is refused", async () => {
    // null used to mean the sector itself; the sector's own id does now.
    const { engine } = await makeEngine();
    const errors = await checkObject(engine, ORIGIN, obj(null));
    assert.ok(codes(errors).has("type_error"));
  });

  test("a parent that does not exist is refused", async () => {
    const { engine } = await makeEngine();
    const errors = await checkObject(engine, ORIGIN, obj("obj_nope"));
    assert.ok(codes(errors).has("no_such_parent"));
  });

  test("an object may hang on another object in the same sector", async () => {
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { object: first, errors } = await engine.createObject(agent, obj(await root(engine, agent)));
    assert.deepEqual(errors, []);
    assert.deepEqual(
      await checkObject(engine, agent.coordinates[0]!, obj(first!.objectId)),
      [],
    );
  });

  test("an object in another agent's sector is not a valid parent", async () => {
    const { engine } = await makeEngine();
    const { agent: one } = await settle(engine, "one");
    const { agent: two } = await settle(engine, "two");
    const { object: theirs } = await engine.createObject(one, obj(await root(engine, one)));

    const errors = await checkObject(engine, two.coordinates[0]!, obj(theirs!.objectId));
    assert.ok(codes(errors).has("no_such_parent"));
  });

  test("someone else's object is indistinguishable from a missing one", async () => {
    // An agent has no business learning what stands in another sector.
    const { engine } = await makeEngine();
    const { agent: one } = await settle(engine, "one");
    const { agent: two } = await settle(engine, "two");
    const { object: theirs } = await engine.createObject(
      one,
      obj(await root(engine, one), { title: "Their Secret Thing" }),
    );

    const trespass = await checkObject(engine, two.coordinates[0]!, obj(theirs!.objectId));
    const missing = await checkObject(engine, two.coordinates[0]!, obj("obj_deadbeefdeadbeef"));
    assert.deepEqual(codes(trespass), codes(missing));
    assert.ok(!trespass[0]!.message.includes("Their Secret Thing"));
  });

  test("the object graph cannot cycle", async () => {
    // A parent must already exist, so a cycle is unrepresentable.
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { object: first } = await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: "Crate" }),
    );
    const { object: second } = await engine.createObject(
      agent,
      obj(first!.objectId, { title: "Tin" }),
    );

    // The only way to close a loop would be to repoint an existing object, and
    // nothing in the API can do that.
    assert.equal(second!.parentId, first!.objectId);
    assert.equal((await engine.store.getObject(first!.objectId))!.parentId, null);
  });
});
