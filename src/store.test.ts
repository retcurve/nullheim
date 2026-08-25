/**
 * The frontier and object indexes are maintained on write, not computed on read.
 *
 * That is a performance change with a correctness risk: an index can silently
 * drift from the definition it replaced. So these tests keep a reference
 * implementation of the old full-scan behaviour and assert the index agrees with
 * it, rather than asserting the index matches itself.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as coords from "./coords.ts";
import { MAX_XY, type CoordKey, type Coordinate } from "./coords.ts";
import { parseSector } from "./schema.ts";
import { WorldStore, type WorldObject } from "./store.ts";
import { seeded } from "./random.ts";
import { sector } from "./testing.ts";

/** The pre-index definition: scan every sector, collect empty neighbours. */
function referenceFrontier(store: WorldStore): Set<CoordKey> {
  const slots = new Set<CoordKey>();
  for (const baked of store.sectors()) {
    for (const [, neighbour] of coords.neighbours(baked.sector.coordinate)) {
      if (!store.isBaked(neighbour) && coords.inBounds(neighbour)) {
        slots.add(coords.key(neighbour));
      }
    }
  }
  return slots;
}

/** The pre-index definition: filter every object in the world. */
function referenceObjectsIn(store: WorldStore, coordinate: Coordinate): WorldObject[] {
  return store
    .allObjects()
    .filter((o) => coords.equals(o.coordinate, coordinate))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function bakeAt(store: WorldStore, x: number, y: number, agentId = "a"): void {
  const { parsed, errors } = parseSector(sector([x, y]));
  assert.ok(parsed !== null && errors.length === 0, JSON.stringify(errors));
  store.bake({
    sector: parsed,
    sectorId: `sec_test_${x}_${y}`,
    agentId,
    bakedAt: 0.0,
  });
}

describe("the frontier index", () => {
  test("an empty world has an empty frontier", () => {
    const store = new WorldStore();
    assert.equal(store.openSlots().size, 0);
  });

  test("the first sector opens four slots", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    assert.deepEqual(store.openSlots(), referenceFrontier(store));
    assert.equal(store.openSlots().size, 4);
  });

  test("the index matches the full scan at every step", () => {
    // The property that matters: the index never drifts from the definition.
    const rng = seeded(17);
    const store = new WorldStore();
    bakeAt(store, 0, 0);

    for (let step = 0; step < 400; step += 1) {
      const candidates = [...store.openSlots()].map(coords.fromKey).sort(coords.compare);
      const slot = candidates[rng.below(candidates.length)]!;
      bakeAt(store, slot.x, slot.y);
      assert.deepEqual(
        store.openSlots(),
        referenceFrontier(store),
        `drifted at step ${step} (${store.count()} sectors)`,
      );
    }
  });

  test("filling a hole removes it from the frontier", () => {
    // The discard half of the update — easy to omit and rarely noticed.
    const store = new WorldStore();
    for (const [x, y] of [
      [0, 0],
      [2, 0],
      [1, 1],
      [1, -1],
    ] as const) {
      bakeAt(store, x, y);
    }
    const hole = coords.key(coords.coord(1, 0));
    assert.ok(store.openSlots().has(hole));

    bakeAt(store, 1, 0);
    assert.ok(!store.openSlots().has(hole));
    assert.deepEqual(store.openSlots(), referenceFrontier(store));
  });

  test("the frontier stops at the lattice edge", () => {
    const store = new WorldStore();
    bakeAt(store, MAX_XY, 0);
    assert.ok(!store.openSlots().has(coords.key(coords.coord(MAX_XY + 1, 0))));
    assert.ok(store.openSlots().has(coords.key(coords.coord(MAX_XY - 1, 0))));
    assert.deepEqual(store.openSlots(), referenceFrontier(store));
  });

  test("callers cannot mutate the index through openSlots", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    store.openSlots().clear();
    assert.equal(store.openSlots().size, 4);
  });
});

describe("the object index", () => {
  test("callers cannot mutate the index through objectsIn", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    const origin = coords.ORIGIN;
    store.addObject({
      objectId: "obj_1",
      coordinate: origin,
      parentId: null,
      title: "A Thing",
      description: "d",
      agentId: "a",
      createdAt: 1,
    });
    store.objectsIn(origin).length = 0;
    assert.equal(store.objectsIn(origin).length, 1);
  });

  test("objects come back oldest first, and never leak a neighbour", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    bakeAt(store, 0, 1);
    const here = coords.ORIGIN;
    const next = coords.coord(0, 1);

    for (const [index, title] of ["First", "Second", "Third"].entries()) {
      store.addObject({
        objectId: `obj_here_${index}`,
        coordinate: here,
        parentId: null,
        title,
        description: "d",
        agentId: "a",
        createdAt: index + 1,
      });
      store.addObject({
        objectId: `obj_next_${index}`,
        coordinate: next,
        parentId: null,
        title: `next-${title}`,
        description: "d",
        agentId: "b",
        createdAt: index + 1,
      });
    }

    assert.deepEqual(
      store.objectsIn(here).map((o) => o.title),
      ["First", "Second", "Third"],
    );
    assert.deepEqual(store.objectsIn(here), referenceObjectsIn(store, here));
    assert.deepEqual(store.objectsIn(next), referenceObjectsIn(store, next));
  });

  test("childrenOf selects only the requested parent", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    const at = coords.ORIGIN;
    const add = (id: string, parentId: string | null, createdAt: number) =>
      store.addObject({
        objectId: id,
        coordinate: at,
        parentId,
        title: id,
        description: "d",
        agentId: "a",
        createdAt,
      });
    add("obj_bench", null, 1);
    add("obj_can", "obj_bench", 2);
    add("obj_crate", null, 3);

    assert.deepEqual(
      store.childrenOf(null, at).map((o) => o.objectId),
      ["obj_bench", "obj_crate"],
    );
    assert.deepEqual(
      store.childrenOf("obj_bench", at).map((o) => o.objectId),
      ["obj_can"],
    );
  });
});

describe("derived exits", () => {
  test("every side with a neighbour is an exit, labelled with its own title", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    const { parsed } = parseSector(
      sector([0, 1], { title: "The Moth Orangery", short_description: "Green glass." }),
    );
    store.bake({
      sector: parsed!,
      sectorId: "sec_north",
      agentId: "b",
      bakedAt: 0,
    });

    const exits = store.exitsFrom(coords.ORIGIN);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.direction, "north");
    assert.equal(exits[0]!.name, "The Moth Orangery");
    assert.equal(exits[0]!.description, "Green glass.");
    assert.deepEqual(exits[0]!.to, [0, 1]);
  });

  test("a lone sector has no exits at all", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    assert.deepEqual(store.exitsFrom(coords.ORIGIN), []);
  });

  test("edges are derived in both directions and sorted", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    bakeAt(store, 0, 1);
    const edges = store.edges();
    assert.equal(edges.length, 2);
    assert.deepEqual(edges[0], { from: [0, 0], direction: "north", to: [0, 1] });
    assert.deepEqual(edges[1], { from: [0, 1], direction: "south", to: [0, 0] });
  });
});

describe("the static lock", () => {
  test("a baked sector cannot be rewritten", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    assert.throws(() => bakeAt(store, 0, 0), /already baked/);
  });

  test("an object id cannot be reused", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    const o = {
      objectId: "obj_1",
      coordinate: coords.ORIGIN,
      parentId: null,
      title: "t",
      description: "d",
      agentId: "a",
      createdAt: 1,
    };
    store.addObject(o);
    assert.throws(() => store.addObject(o), /already exists/);
  });

  test("a sector can be found by its id", () => {
    const store = new WorldStore();
    bakeAt(store, 0, 0);
    assert.equal(store.getById("sec_test_0_0")?.sectorId, "sec_test_0_0");
    assert.equal(store.getById("sec_nope"), null);
  });
});
