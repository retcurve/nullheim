/**
 * Tests for validateSector, validateObject, and validateInteraction: identity,
 * ownership, and reachability rules.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as coords from "./coords.ts";
import { ORIGIN, coord, type Coordinate } from "./coords.ts";
import type { Engine } from "./engine.ts";
import type { ValidationError } from "./errors.ts";
import { parseInteraction, parseObject, parseSector } from "./schema.ts";
import {
  validateInteraction,
  validateObject,
  validateSector,
  type InteractionValidationStore,
  type ValidationStore,
} from "./validation.ts";
import { codes, found, interaction, makeEngine, obj, root, sector, settle } from "./testing.ts";

/**
 * Prefetches the data validateSector can ask for, then builds a synchronous
 * store facade over it and calls validateSector.
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
    get: () => null,
    getObject: () => null,
    count: () => count,
  };
  return [...errors, ...validateSector(parsed, at, store)];
}

/** Calls validateObject with `at` as the sector under test. */
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
    isBaked: () => false,
    get: (c) => (coords.equals(c, at) ? atSector : null),
    getObject: (id) => (id === parsed.parentId ? parent : null),
    count: () => 0,
  };
  return [...errors, ...validateObject(parsed, [at], store)];
}

/** Calls validateInteraction with `sectorCoordinates` as the caller's set of sectors. */
async function checkInteraction(
  engine: Engine,
  sectorCoordinates: readonly Coordinate[],
  payload: unknown,
): Promise<ValidationError[]> {
  const { parsed, errors } = parseInteraction(payload);
  if (parsed === null) {
    return errors;
  }
  const [a, b, exists] = await Promise.all([
    engine.store.getObject(parsed.objectAId),
    engine.store.getObject(parsed.objectBId),
    engine.store.interactionExists(parsed.objectAId, parsed.objectBId),
  ]);
  const store: InteractionValidationStore = {
    getObject: (id) => (id === parsed.objectAId ? a : id === parsed.objectBId ? b : null),
    interactionExists: () => exists,
  };
  return [...errors, ...validateInteraction(parsed, sectorCoordinates, store)];
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

    assert.equal(second!.parentId, first!.objectId);
    assert.equal((await engine.store.getObject(first!.objectId))!.parentId, null);
  });
});

describe("interaction rules", () => {
  test("two objects in the same sector may interact", async () => {
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Rope" }));
    const { object: b } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Hook" }));

    assert.deepEqual(
      await checkInteraction(engine, agent.coordinates, interaction(a!.objectId, b!.objectId)),
      [],
    );
  });

  test("an object cannot interact with itself", async () => {
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent)));

    const errors = await checkInteraction(engine, agent.coordinates, interaction(a!.objectId, a!.objectId));
    assert.ok(codes(errors).has("same_object"));
  });

  test("a nonexistent object is refused", async () => {
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent)));

    const errors = await checkInteraction(
      engine,
      agent.coordinates,
      interaction(a!.objectId, "obj_nope"),
    );
    assert.ok(codes(errors).has("no_such_object"));
  });

  test("an object in another agent's sector is indistinguishable from a missing one", async () => {
    const { engine } = await makeEngine();
    const { agent: one } = await settle(engine, "one");
    const { agent: two } = await settle(engine, "two");
    const { object: mine } = await engine.createObject(one, obj(await root(engine, one)));
    const { object: theirs } = await engine.createObject(
      two,
      obj(await root(engine, two), { title: "Their Secret Thing" }),
    );

    const trespass = await checkInteraction(engine, one.coordinates, interaction(mine!.objectId, theirs!.objectId));
    const missing = await checkInteraction(
      engine,
      one.coordinates,
      interaction(mine!.objectId, "obj_deadbeefdeadbeef"),
    );
    assert.deepEqual(codes(trespass), codes(missing));
    assert.ok(!trespass.some((e) => e.message.includes("Their Secret Thing")));
  });

  test("two objects in different sectors, even both the caller's own, are refused", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);
    await found(engine, agent);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent, 0)));
    const { object: b } = await engine.createObject(agent, obj(await root(engine, agent, 1)));

    const errors = await checkInteraction(engine, agent.coordinates, interaction(a!.objectId, b!.objectId));
    assert.ok(codes(errors).has("different_sectors"));
  });

  test("a pair of objects may only ever get one interaction", async () => {
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Rope" }));
    const { object: b } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Hook" }));

    const { interaction: made, errors } = await engine.createInteraction(
      agent,
      interaction(a!.objectId, b!.objectId),
    );
    assert.deepEqual(errors, []);
    assert.notEqual(made, null);

    const again = await checkInteraction(engine, agent.coordinates, interaction(a!.objectId, b!.objectId));
    assert.ok(codes(again).has("interaction_exists"));
    const reversed = await checkInteraction(engine, agent.coordinates, interaction(b!.objectId, a!.objectId));
    assert.ok(codes(reversed).has("interaction_exists"));
  });
});
