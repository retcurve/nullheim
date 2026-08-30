/**
 * Durability: everything written against a file-backed database is still
 * there once it is reopened.
 *
 * SQLite (via node:sqlite locally, or D1 in production) owns the actual
 * crash-safety mechanics — the WAL, the atomic commit, recovering from a
 * torn write. Re-testing those would just be re-testing SQLite. What is
 * still ours to get wrong is everything layered on top of it: that `bake()`
 * commits the sector *and* its frontier update together, that an agent's
 * repeated saves really do collapse to one row via the upsert in
 * `registry.ts`, and that none of it depends on any state kept in this
 * process — a second `WorldStore`/`Registry` pair opened against the same
 * file, as a restart would produce, must see exactly what the first one
 * wrote.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_SQL } from "./db/schema.node.ts";
import { openSqlite, type SqliteDb } from "./db/sqlite.ts";
import * as coords from "./coords.ts";
import { ensureGenesis } from "./engine.ts";
import { parseSector } from "./schema.ts";
import { Registry } from "./registry.ts";
import { WorldStore } from "./store.ts";
import { sector } from "./testing.ts";

/** A world in a temp directory, reopenable as if after a restart. */
class WorldOnDisk {
  readonly dir: string;
  readonly path: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "nullheim-"));
    this.path = join(this.dir, "world.sqlite");
  }

  async open(): Promise<SqliteDb> {
    const db = openSqlite(this.path);
    await db.exec(SCHEMA_SQL);
    return db;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const opened: SqliteDb[] = [];
const worlds: WorldOnDisk[] = [];

function makeWorld(): WorldOnDisk {
  const world = new WorldOnDisk();
  worlds.push(world);
  return world;
}

function track(db: SqliteDb): SqliteDb {
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
  for (const world of worlds.splice(0)) {
    world.cleanup();
  }
});

async function bakeAt(store: WorldStore, x: number, y: number): Promise<void> {
  const { parsed, errors } = parseSector(sector([x, y]));
  assert.ok(parsed !== null && errors.length === 0, JSON.stringify(errors));
  await store.bake({
    sector: parsed,
    sectorId: `sec_test_${x}_${y}`,
    agentId: "a",
    bakedAt: x * 100 + y,
  });
}

describe("sectors and the frontier", () => {
  test("sectors survive a reopen", async () => {
    const world = makeWorld();
    const db = track(await world.open());
    const store = new WorldStore(db);
    for (let x = 0; x < 5; x += 1) {
      await bakeAt(store, x, 0);
    }

    const reopened = track(await world.open());
    const reopenedStore = new WorldStore(reopened);
    assert.equal(await reopenedStore.count(), 5);
  });

  test("the frontier survives a reopen exactly as it was", async () => {
    const world = makeWorld();
    const db = track(await world.open());
    const store = new WorldStore(db);
    await bakeAt(store, 0, 0);
    for (const [x, y] of [
      [0, 1],
      [1, 1],
      [1, 0],
    ] as const) {
      await bakeAt(store, x, y);
    }
    const before = await store.openSlots();

    const reopened = track(await world.open());
    const reopenedStore = new WorldStore(reopened);
    assert.deepEqual(await reopenedStore.openSlots(), before);
  });

  test("new writes after a reopen build on what was already there", async () => {
    const world = makeWorld();
    const first = track(await world.open());
    await new WorldStore(first).bake({
      sector: parseSector(sector([0, 0])).parsed!,
      sectorId: "sec_test_0_0",
      agentId: "a",
      bakedAt: 0,
    });

    const reopened = track(await world.open());
    const reopenedStore = new WorldStore(reopened);
    await bakeAt(reopenedStore, 1, 0);

    const final = track(await world.open());
    assert.equal(await new WorldStore(final).count(), 2);
  });
});

describe("objects", () => {
  test("objects survive a reopen, oldest first", async () => {
    const world = makeWorld();
    const db = track(await world.open());
    const store = new WorldStore(db);
    await bakeAt(store, 0, 0);
    for (const [index, title] of ["First", "Second", "Third"].entries()) {
      await store.addObject({
        objectId: `obj_${index}`,
        coordinate: coords.ORIGIN,
        parentId: null,
        title,
        description: "d",
        agentId: "a",
        createdAt: index + 1,
      });
    }

    const reopened = track(await world.open());
    const reopenedStore = new WorldStore(reopened);
    assert.deepEqual(
      (await reopenedStore.objectsIn(coords.ORIGIN)).map((o) => o.title),
      ["First", "Second", "Third"],
    );
  });
});

describe("agents", () => {
  test("a token, its sectors, and its object count all survive a reopen", async () => {
    const world = makeWorld();
    const db = track(await world.open());
    await ensureGenesis(new WorldStore(db));
    const registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    const { agent, token } = await registry.register("persisto");
    const claim = await registry.allocate(agent);
    // settle() only touches the agents and claims tables — no sector needs to
    // actually be baked to exercise the persistence this test is about.
    await registry.settle(agent, claim);
    await registry.noteContribution(agent);

    const reopened = track(await world.open());
    const reopenedRegistry = new Registry(reopened, { cooldownSeconds: 0, claimsPerHour: 0 });
    const revived = await reopenedRegistry.authenticate(token);
    assert.notEqual(revived, null, "the token must still authenticate");
    assert.deepEqual(revived!.coordinates, [claim.coordinate]);
    assert.equal(revived!.objectsCreated, 1);
  });

  test("only the last of many saves for one agent survives", async () => {
    const world = makeWorld();
    const db = track(await world.open());
    const registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    const { agent, token } = await registry.register("grinder");

    // Each contribution re-saves the whole agent row (see registry.ts's
    // #persist) — the same upsert this test is really about, whether it
    // fires once or a dozen times.
    for (let i = 0; i < 12; i += 1) {
      agent.objectsCreated = i;
      await registry.noteContribution(agent);
    }

    const reopened = track(await world.open());
    const reopenedRegistry = new Registry(reopened, { cooldownSeconds: 0, claimsPerHour: 0 });
    const revived = await reopenedRegistry.authenticate(token);
    assert.equal(revived!.objectsCreated, 12);
    assert.equal((await reopenedRegistry.stats()).agents, 1);
  });
});
