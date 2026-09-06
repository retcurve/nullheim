/**
 * Compares the frontier and object indexes against a full-scan reference
 * implementation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_SQL } from "../src/db/schema.node.ts";
import { openSqlite, type SqliteDb } from "../src/db/sqlite.ts";
import * as coords from "../src/coords.ts";
import { MAX_XY, type CoordKey, type Coordinate } from "../src/coords.ts";
import { parseSector } from "../src/schema.ts";
import { WorldStore, type WorldObject } from "../src/store.ts";
import { sector } from "./testing.ts";

/**
 * mulberry32. Gives the differential walk below a fixed sequence, so a
 * failure at step N reproduces on the next run.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function freshStore(): Promise<{ store: WorldStore; db: SqliteDb }> {
  const db = openSqlite(":memory:");
  await db.exec(SCHEMA_SQL);
  return { store: new WorldStore(db), db };
}

/** Scans every sector and collects the empty neighbours of each. */
async function referenceFrontier(store: WorldStore): Promise<Set<CoordKey>> {
  const slots = new Set<CoordKey>();
  for (const baked of await store.sectors()) {
    for (const [, neighbour] of coords.neighbours(baked.sector.coordinate)) {
      if (!(await store.isBaked(neighbour)) && coords.inBounds(neighbour)) {
        slots.add(coords.key(neighbour));
      }
    }
  }
  return slots;
}

/** Filters every object in the world down to the given coordinate. */
async function referenceObjectsIn(
  store: WorldStore,
  coordinate: Coordinate,
): Promise<WorldObject[]> {
  return (await store.allObjects())
    .filter((o) => coords.equals(o.coordinate, coordinate))
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function bakeAt(store: WorldStore, x: number, y: number, agentId = "a"): Promise<void> {
  const { parsed, errors } = parseSector(sector([x, y]));
  assert.ok(parsed !== null && errors.length === 0, JSON.stringify(errors));
  await store.bake(
    {
      sector: parsed,
      sectorId: `sec_test_${x}_${y}`,
      agentId,
      bakedAt: 0.0,
    },
    null,
  );
}

describe("the frontier index", () => {
  test("an empty world has an empty frontier", async () => {
    const { store } = await freshStore();
    assert.equal((await store.openSlots()).size, 0);
  });

  test("the first sector opens four slots", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    assert.deepEqual(await store.openSlots(), await referenceFrontier(store));
    assert.equal((await store.openSlots()).size, 4);
  });

  test("the index matches the full scan at every step", async () => {
    const rng = seeded(17);
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);

    for (let step = 0; step < 400; step += 1) {
      const candidates = [...(await store.openSlots())].map(coords.fromKey).sort(coords.compare);
      const slot = candidates[Math.floor(rng() * candidates.length)]!;
      await bakeAt(store, slot.x, slot.y);
      assert.deepEqual(
        await store.openSlots(),
        await referenceFrontier(store),
        `drifted at step ${step} (${await store.count()} sectors)`,
      );
    }
  });

  test("filling a hole removes it from the frontier", async () => {
    const { store } = await freshStore();
    for (const [x, y] of [
      [0, 0],
      [2, 0],
      [1, 1],
      [1, -1],
    ] as const) {
      await bakeAt(store, x, y);
    }
    const hole = coords.key(coords.coord(1, 0));
    assert.ok((await store.openSlots()).has(hole));

    await bakeAt(store, 1, 0);
    assert.ok(!(await store.openSlots()).has(hole));
    assert.deepEqual(await store.openSlots(), await referenceFrontier(store));
  });

  test("the frontier stops at the lattice edge", async () => {
    const { store } = await freshStore();
    await bakeAt(store, MAX_XY, 0);
    assert.ok(!(await store.openSlots()).has(coords.key(coords.coord(MAX_XY + 1, 0))));
    assert.ok((await store.openSlots()).has(coords.key(coords.coord(MAX_XY - 1, 0))));
    assert.deepEqual(await store.openSlots(), await referenceFrontier(store));
  });

  test("callers cannot mutate the index through openSlots", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    (await store.openSlots()).clear();
    assert.equal((await store.openSlots()).size, 4);
  });
});

describe("the object index", () => {
  test("callers cannot mutate the index through objectsIn", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    const origin = coords.ORIGIN;
    await store.addObject({
      objectId: "obj_1",
      coordinate: origin,
      parentId: null,
      title: "A Thing",
      description: "d",
      image: null,
      useText: null,
      agentId: "a",
      createdAt: 1,
    });
    (await store.objectsIn(origin)).length = 0;
    assert.equal((await store.objectsIn(origin)).length, 1);
  });

  test("objects come back oldest first, and never leak a neighbour", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    await bakeAt(store, 0, 1);
    const here = coords.ORIGIN;
    const next = coords.coord(0, 1);

    for (const [index, title] of ["First", "Second", "Third"].entries()) {
      await store.addObject({
        objectId: `obj_here_${index}`,
        coordinate: here,
        parentId: null,
        title,
        description: "d",
        image: null,
        useText: null,
        agentId: "a",
        createdAt: index + 1,
      });
      await store.addObject({
        objectId: `obj_next_${index}`,
        coordinate: next,
        parentId: null,
        title: `next-${title}`,
        description: "d",
        image: null,
        useText: null,
        agentId: "b",
        createdAt: index + 1,
      });
    }

    assert.deepEqual(
      (await store.objectsIn(here)).map((o) => o.title),
      ["First", "Second", "Third"],
    );
    assert.deepEqual(await store.objectsIn(here), await referenceObjectsIn(store, here));
    assert.deepEqual(await store.objectsIn(next), await referenceObjectsIn(store, next));
  });

  test("childrenOf selects only the requested parent", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    const at = coords.ORIGIN;
    const add = (id: string, parentId: string | null, createdAt: number) =>
      store.addObject({
        objectId: id,
        coordinate: at,
        parentId,
        title: id,
        description: "d",
        image: null,
        useText: null,
        agentId: "a",
        createdAt,
      });
    await add("obj_bench", null, 1);
    await add("obj_can", "obj_bench", 2);
    await add("obj_crate", null, 3);

    assert.deepEqual(
      (await store.childrenOf(null, at)).map((o) => o.objectId),
      ["obj_bench", "obj_crate"],
    );
    assert.deepEqual(
      (await store.childrenOf("obj_bench", at)).map((o) => o.objectId),
      ["obj_can"],
    );
  });
});

describe("derived exits", () => {
  test("every side with a neighbour is an exit, labelled with its own title", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    const { parsed } = parseSector(
      sector([0, 1], { title: "The Moth Orangery", short_description: "Green glass." }),
    );
    await store.bake(
      {
        sector: parsed!,
        sectorId: "sec_north",
        agentId: "b",
        bakedAt: 0,
      },
      null,
    );

    const exits = await store.exitsFrom(coords.ORIGIN);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.direction, "north");
    assert.equal(exits[0]!.name, "The Moth Orangery");
    assert.equal(exits[0]!.description, "Green glass.");
    assert.deepEqual(exits[0]!.to, [0, 1]);
  });

  test("a lone sector has no exits at all", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    assert.deepEqual(await store.exitsFrom(coords.ORIGIN), []);
  });

  test("edges are derived in both directions and sorted", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    await bakeAt(store, 0, 1);
    const edges = await store.edges();
    assert.equal(edges.length, 2);
    assert.deepEqual(edges[0], { from: [0, 0], direction: "north", to: [0, 1] });
    assert.deepEqual(edges[1], { from: [0, 1], direction: "south", to: [0, 0] });
  });
});

describe("the static lock", () => {
  test("a baked sector cannot be rewritten", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    await assert.rejects(bakeAt(store, 0, 0), /already baked/);
  });

  test("an object id cannot be reused", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    const o: WorldObject = {
      objectId: "obj_1",
      coordinate: coords.ORIGIN,
      parentId: null,
      title: "t",
      description: "d",
      image: null,
      useText: null,
      agentId: "a",
      createdAt: 1,
    };
    await store.addObject(o);
    await assert.rejects(store.addObject(o), /already exists/);
  });

  test("a sector can be found by its id", async () => {
    const { store } = await freshStore();
    await bakeAt(store, 0, 0);
    assert.equal((await store.getById("sec_test_0_0"))?.sectorId, "sec_test_0_0");
    assert.equal(await store.getById("sec_nope"), null);
  });
});
