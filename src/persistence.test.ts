/**
 * Durability: a compacted snapshot plus an append-only log.
 *
 * The contract this has to keep is narrow and absolute. A sector is permanent
 * and an agent waits eight hours per object, so once the API has answered
 * "baked", a crash must not take it back. Everything here is about what survives.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as coords from "./coords.ts";
import { parseSector } from "./schema.ts";
import { WorldStore } from "./store.ts";
import { sector } from "./testing.ts";

/** A world in a temp directory that can be reopened as if after a crash. */
class WorldOnDisk {
  readonly dir: string;
  readonly path: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "mosaic-"));
    this.path = join(this.dir, "world.json");
  }

  get logPath(): string {
    return `${this.path}.log`;
  }

  open(minCompactRecords?: number): WorldStore {
    return new WorldStore(
      this.path,
      minCompactRecords === undefined ? {} : { minCompactRecords },
    );
  }

  logLines(): string[] {
    const raw = readFileSync(this.logPath, "utf-8");
    return raw === "" ? [] : raw.split("\n").filter((line) => line !== "");
  }

  snapshot(): Record<string, any> {
    return JSON.parse(readFileSync(this.path, "utf-8"));
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const opened: WorldStore[] = [];
const worlds: WorldOnDisk[] = [];

function makeWorld(): WorldOnDisk {
  const world = new WorldOnDisk();
  worlds.push(world);
  return world;
}

function track(store: WorldStore): WorldStore {
  opened.push(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) {
    store.close();
  }
  for (const world of worlds.splice(0)) {
    world.cleanup();
  }
});

function bakeAt(store: WorldStore, x: number, y: number): void {
  const { parsed, errors } = parseSector(sector([x, y]));
  assert.ok(parsed !== null && errors.length === 0, JSON.stringify(errors));
  store.bake({
    sector: parsed,
    sectorId: `sec_test_${x}_${y}`,
    agentId: "a",
    bakedAt: x * 100 + y,
  });
}

describe("durability", () => {
  test("writes survive with no snapshot at all", () => {
    // The ordinary case: everything lives in the log until compaction.
    const world = makeWorld();
    const store = world.open();
    for (let x = 0; x < 5; x += 1) {
      bakeAt(store, x, 0);
    }
    store.close();

    assert.ok(!existsSync(world.path), "no snapshot should be needed yet");
    assert.ok(existsSync(world.logPath));

    const reopened = track(world.open());
    assert.equal(reopened.count(), 5);
    assert.deepEqual(reopened.openSlots(), store.openSlots());
  });

  test("the snapshot is not rewritten on every write", () => {
    // The whole point: a write must not cost O(world).
    const world = makeWorld();
    const store = track(world.open());
    for (let x = 0; x < 20; x += 1) {
      bakeAt(store, x, 0);
    }
    assert.ok(!existsSync(world.path));
    assert.equal(world.logLines().length, 20);
  });

  test("a torn final line is dropped and the rest survives", () => {
    // A crash mid-append. The torn write was never acknowledged.
    const world = makeWorld();
    const store = world.open();
    for (let x = 0; x < 4; x += 1) {
      bakeAt(store, x, 0);
    }
    store.close();

    appendFileSync(world.logPath, '{"t": "sector", "d": {"sector": {"coord'); // cut off

    const reopened = track(world.open());
    assert.equal(reopened.count(), 4);
  });

  test("a trailing burst of NUL bytes is survivable", () => {
    const world = makeWorld();
    const store = world.open();
    bakeAt(store, 0, 0);
    store.close();
    appendFileSync(world.logPath, "\x00\x00\x00");

    const reopened = track(world.open());
    assert.equal(reopened.count(), 1);
  });

  test("corruption in the middle refuses to load", () => {
    // Silently skipping it would quietly lose somebody's permanent sector.
    const world = makeWorld();
    const store = world.open();
    for (let x = 0; x < 4; x += 1) {
      bakeAt(store, x, 0);
    }
    store.close();

    const lines = world.logLines();
    lines[1] = "{ this is not json";
    writeFileSync(world.logPath, `${lines.join("\n")}\n`);

    assert.throws(() => world.open(), /corrupt at line 2/);
  });

  test("new writes append after a restart", () => {
    const world = makeWorld();
    const store = world.open();
    bakeAt(store, 0, 0);
    store.close();

    const reopened = world.open();
    bakeAt(reopened, 1, 0);
    reopened.close();

    const final = track(world.open());
    assert.equal(final.count(), 2);
    assert.equal(world.logLines().length, 2);
  });

  test("an unwritten world needs no files", () => {
    const store = new WorldStore(); // no path at all
    bakeAt(store, 0, 0);
    assert.equal(store.count(), 1);
    store.close();
  });
});

describe("compaction", () => {
  test("the log folds into the snapshot at the threshold", () => {
    const world = makeWorld();
    const store = track(world.open(10));
    for (let x = 0; x < 10; x += 1) {
      bakeAt(store, x, 0);
    }

    assert.ok(existsSync(world.path));
    assert.equal(readFileSync(world.logPath, "utf-8"), "", "log should be truncated");
    assert.equal(Object.keys(world.snapshot()["sectors"]).length, 10);
  });

  test("a compacted world reloads identically", () => {
    const world = makeWorld();
    const store = world.open(10);
    for (let x = 0; x < 14; x += 1) {
      // crosses the threshold, then writes more
      bakeAt(store, x, 0);
    }
    const before = store.openSlots();
    store.close();

    const reopened = track(world.open(10));
    assert.equal(reopened.count(), 14);
    assert.deepEqual(reopened.openSlots(), before);
  });

  test("compaction keeps firing as the world grows", () => {
    // The log must stay bounded, not compact once and then never again.
    // Measured against the world size at the last compaction. Comparing it
    // against the current size looks right and never fires, because every
    // append grows the log and the world together.
    const world = makeWorld();
    const store = track(world.open(10));
    for (let x = 0; x < 300; x += 1) {
      bakeAt(store, x, 0);
    }

    const pending = world.logLines().length;
    const snapshotted = Object.keys(world.snapshot()["sectors"]).length;
    assert.ok(pending < 150, `log is not being folded back in (${pending} pending)`);
    assert.ok(snapshotted > 150, `snapshot is falling behind the world (${snapshotted})`);
  });

  test("a crash between snapshot and truncate is survivable", () => {
    // Replay is idempotent, so records already in the snapshot are harmless.
    // The snapshot is made durable before the log is dropped. If the process
    // dies in between, those records get replayed on top of a snapshot that
    // already contains them — which must not double-apply or raise.
    const world = makeWorld();
    const store = world.open();
    for (let x = 0; x < 4; x += 1) {
      bakeAt(store, x, 0);
    }
    store.compact();
    assert.equal(readFileSync(world.logPath, "utf-8"), "");

    // Put the already-compacted records back, as an interrupted truncate would.
    const payload = world.snapshot();
    const replayed = Object.values(payload["sectors"])
      .map((value) => JSON.stringify({ t: "sector", d: value }))
      .join("\n");
    writeFileSync(world.logPath, `${replayed}\n`);
    const before = store.openSlots();
    store.close();

    const reopened = track(world.open());
    assert.equal(reopened.count(), 4);
    assert.deepEqual(reopened.openSlots(), before);
  });

  test("the frontier survives a snapshot round trip", () => {
    const world = makeWorld();
    const first = world.open();
    bakeAt(first, 0, 0);
    for (const [x, y] of [
      [0, 1],
      [1, 1],
      [1, 0],
    ] as const) {
      bakeAt(first, x, y);
    }
    const before = first.openSlots();
    first.compact();
    first.close();

    const reloaded = track(world.open());
    assert.deepEqual(reloaded.openSlots(), before);
  });

  test("an agent survives a restart, including a later update", () => {
    const world = makeWorld();
    const first = world.open();
    first.saveAgent({
      agentId: "agent_a",
      tokenHash: "hash_a",
      label: "persisto",
      createdAt: 10,
      coordinates: [coords.ORIGIN],
      nextContributionAt: 0,
      objectsCreated: 0,
    });
    first.close();

    const reopened = track(world.open());
    const [record] = reopened.agentRecords();
    assert.deepEqual(record, {
      agentId: "agent_a",
      tokenHash: "hash_a",
      label: "persisto",
      createdAt: 10,
      coordinates: [coords.ORIGIN],
      nextContributionAt: 0,
      objectsCreated: 0,
    });

    // A second save for the same id is an update, not a new agent — this is
    // what makes replaying a log of many saves for one agent work at all.
    reopened.saveAgent({ ...record, objectsCreated: 1, nextContributionAt: 500 });
    reopened.close();

    const final = track(world.open());
    assert.equal(final.agentRecords().length, 1);
    assert.equal(final.agentRecords()[0]!.objectsCreated, 1);
  });

  test("compaction keeps only the latest save for a repeatedly-updated agent", () => {
    const world = makeWorld();
    const store = track(world.open(10));
    const base = {
      agentId: "agent_a",
      tokenHash: "hash_a",
      label: "grinder",
      createdAt: 0,
      coordinates: [],
      nextContributionAt: 0,
    };
    for (let i = 0; i < 12; i += 1) {
      store.saveAgent({ ...base, objectsCreated: i });
    }
    // 12 saves cross the threshold of 10 mid-loop; fold the remainder in too so
    // the snapshot reflects the last save rather than whichever one happened to
    // trigger compaction.
    store.compact();

    assert.ok(existsSync(world.path), "12 saves of one agent should still trigger compaction");
    const snapshotted = world.snapshot()["agents"] as Record<string, { objects_created: number }>;
    assert.equal(Object.keys(snapshotted).length, 1);
    assert.equal(snapshotted["agent_a"]!.objects_created, 11);
  });

  test("the object index is rebuilt by creation time, not file order", () => {
    // JSON object order is not a guarantee, so the rebuild has to sort by
    // createdAt rather than trust the file. Writing the objects back in
    // reverse is what makes this test able to fail.
    const world = makeWorld();
    const first = world.open();
    bakeAt(first, 0, 0);
    for (const [index, title] of ["First", "Second", "Third"].entries()) {
      first.addObject({
        objectId: `obj_${index}`,
        coordinate: coords.ORIGIN,
        parentId: null,
        title,
        description: "d",
        agentId: "a",
        createdAt: index + 1,
      });
    }
    first.compact();
    first.close();

    const payload = world.snapshot();
    payload["objects"] = Object.fromEntries(
      Object.entries(payload["objects"] as Record<string, unknown>).reverse(),
    );
    writeFileSync(world.path, JSON.stringify(payload));

    const reloaded = track(world.open());
    assert.deepEqual(
      reloaded.objectsIn(coords.ORIGIN).map((o) => o.title),
      ["First", "Second", "Third"],
    );
  });
});
