/**
 * World persistence.
 *
 * Sectors are nodes on a flat lattice. Exits are *not* stored — they are derived
 * from adjacency every time they are asked for, which is why no two neighbouring
 * agents can ever disagree about a doorway. Objects hang off sectors and off
 * each other in a tree.
 *
 * Two porting notes:
 *
 * Every index here is keyed by `CoordKey`, the `"x,y"` string, never by a
 * Coordinate object. A `Map<Coordinate, …>` would key on reference identity and
 * quietly hold one entry per *lookup*, not one per square.
 *
 * All of Python's `threading.RLock` acquisitions are gone. Node runs this on one
 * thread and none of the mutating paths await, so a request is already atomic
 * with respect to every other request. What is deliberately *not* dropped is the
 * synchronous fsync: see `appendRecord`.
 */

import { openSync, closeSync, writeSync, fsyncSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

import * as coords from "./coords.ts";
import type { CoordKey, Coordinate, Direction } from "./coords.ts";
import { parseSector, sectorAsDict, type Sector } from "./schema.ts";

export const SNAPSHOT_VERSION = 4;

// Compact once the log reaches roughly the size of the world. That makes the
// O(world) rewrite happen every O(world) writes, so it costs O(1) amortised
// however large the world gets.
export const MIN_COMPACT_RECORDS = 1000;

/** A sector that has passed validation and been locked into the world. */
export interface BakedSector {
  readonly sector: Sector;
  readonly sectorId: string;
  readonly agentId: string;
  readonly bakedAt: number;
}

export function bakedAsDict(baked: BakedSector): Record<string, unknown> {
  return {
    sector: sectorAsDict(baked.sector),
    sector_id: baked.sectorId,
    agent_id: baked.agentId,
    baked_at: baked.bakedAt,
  };
}

export function bakedFromDict(raw: Record<string, unknown>): BakedSector {
  const { parsed, errors } = parseSector(raw["sector"]);
  if (parsed === null || errors.length) {
    // Snapshots only hold sectors that already passed validation, so this means
    // the file was hand-edited or corrupted.
    throw new Error(`corrupt snapshot sector: ${JSON.stringify(errors)}`);
  }
  return {
    sector: parsed,
    sectorId: raw["sector_id"] as string,
    agentId: raw["agent_id"] as string,
    bakedAt: raw["baked_at"] as number,
  };
}

export interface WorldObject {
  readonly objectId: string;
  readonly coordinate: Coordinate;
  readonly parentId: string | null;
  readonly title: string;
  readonly description: string;
  readonly agentId: string;
  readonly createdAt: number;
}

export function objectAsDict(o: WorldObject): Record<string, unknown> {
  return {
    object_id: o.objectId,
    coordinate: coords.asList(o.coordinate),
    parent_id: o.parentId,
    title: o.title,
    description: o.description,
    agent_id: o.agentId,
    created_at: o.createdAt,
  };
}

export function objectFromDict(raw: Record<string, unknown>): WorldObject {
  return {
    objectId: raw["object_id"] as string,
    coordinate: coords.parse(raw["coordinate"]),
    parentId: raw["parent_id"] as string | null,
    title: raw["title"] as string,
    description: raw["description"] as string,
    agentId: raw["agent_id"] as string,
    createdAt: raw["created_at"] as number,
  };
}

export interface Exit {
  readonly direction: Direction;
  readonly name: string;
  readonly description: string;
  readonly to: [number, number];
}

export interface Edge {
  readonly from: [number, number];
  readonly direction: Direction;
  readonly to: [number, number];
}

/** Map-backed world with an optional JSON snapshot on disk. */
export class WorldStore {
  #sectors = new Map<CoordKey, BakedSector>();
  #sectorsById = new Map<string, CoordKey>();
  #objects = new Map<string, WorldObject>();
  // Two indexes maintained on write rather than recomputed on read. Both answer
  // questions the store already knows the answer to at bake time, and both sit
  // on paths hit constantly — claiming and room views.
  #frontier = new Set<CoordKey>();
  #objectsByCoordinate = new Map<CoordKey, WorldObject[]>();

  readonly #path: string | null;
  // Python's tests reached in with `patch.object(store_module, ...)`. A module
  // constant cannot be patched here, so the threshold is injected instead —
  // which is what the tests actually wanted.
  readonly #minCompactRecords: number;
  #logFd: number | null = null;
  #logRecords = 0;
  #compactedSize = 0;

  constructor(
    path: string | null = null,
    options: { minCompactRecords?: number } = {},
  ) {
    this.#path = path;
    this.#minCompactRecords = options.minCompactRecords ?? MIN_COMPACT_RECORDS;
    if (path) {
      this.load();
    }
  }

  // --- sectors ------------------------------------------------------------

  get(coordinate: Coordinate): BakedSector | null {
    return this.#sectors.get(coords.key(coordinate)) ?? null;
  }

  getById(sectorId: string): BakedSector | null {
    const k = this.#sectorsById.get(sectorId);
    return k === undefined ? null : (this.#sectors.get(k) ?? null);
  }

  /** Write a sector permanently. The static lock is enforced here. */
  bake(baked: BakedSector): void {
    const k = coords.key(baked.sector.coordinate);
    if (this.#sectors.has(k)) {
      throw new AlreadyBaked(
        `${coords.toString(baked.sector.coordinate)} is already baked and cannot be rewritten`,
      );
    }
    this.#sectors.set(k, baked);
    this.#sectorsById.set(baked.sectorId, k);
    this.#indexFrontier(baked.sector.coordinate);
    this.#appendRecord("sector", bakedAsDict(baked));
  }

  sectors(): BakedSector[] {
    return [...this.#sectors.values()];
  }

  count(): number {
    return this.#sectors.size;
  }

  isBaked(coordinate: Coordinate): boolean {
    return this.#sectors.has(coords.key(coordinate));
  }

  /**
   * Fold one newly baked sector into the frontier.
   *
   * Exactly five coordinates can change: the one just filled, and its four
   * neighbours, any of which may now touch the world for the first time.
   */
  #indexFrontier(coordinate: Coordinate): void {
    this.#frontier.delete(coords.key(coordinate));
    for (const [, neighbour] of coords.neighbours(coordinate)) {
      const k = coords.key(neighbour);
      if (!this.#sectors.has(k) && coords.inBounds(neighbour)) {
        this.#frontier.add(k);
      }
    }
  }

  /** Recompute both indexes from scratch. Startup only. */
  #rebuildIndexes(): void {
    this.#frontier = new Set();
    this.#sectorsById = new Map();
    for (const [k, baked] of this.#sectors) {
      this.#sectorsById.set(baked.sectorId, k);
    }
    for (const baked of this.#sectors.values()) {
      this.#indexFrontier(baked.sector.coordinate);
    }

    this.#objectsByCoordinate = new Map();
    // Snapshot iteration order is not guaranteed to match creation order, so
    // sort rather than trusting it — objectsIn() promises oldest first.
    const ordered = [...this.#objects.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const world_object of ordered) {
      this.#bucketObject(world_object);
    }
  }

  #bucketObject(world_object: WorldObject): void {
    const k = coords.key(world_object.coordinate);
    const bucket = this.#objectsByCoordinate.get(k);
    if (bucket === undefined) {
      this.#objectsByCoordinate.set(k, [world_object]);
    } else {
      bucket.push(world_object);
    }
  }

  // --- derived exits ------------------------------------------------------

  /**
   * Every side with a neighbour is an exit. Nobody declares these.
   *
   * The label a player reads on the door is the neighbour's own `title`, and
   * examining the door without walking through shows the neighbour's
   * `shortDescription`. So each sector writes the sign on the outside of its own
   * front door, and its neighbours never get a say — which is how two rooms that
   * agree on nothing still join up cleanly.
   */
  exitsFrom(coordinate: Coordinate): Exit[] {
    const found: Exit[] = [];
    for (const [direction, neighbourCoord] of coords.neighbours(coordinate)) {
      const neighbour = this.#sectors.get(coords.key(neighbourCoord));
      if (neighbour === undefined) {
        continue;
      }
      found.push({
        direction,
        name: neighbour.sector.title,
        description: neighbour.sector.shortDescription,
        to: coords.asList(neighbourCoord),
      });
    }
    return found;
  }

  /**
   * Unbaked, in-bounds coordinates touching at least one baked sector.
   *
   * This is the frontier, and the only rule is adjacency — a slot beside a
   * sector with three neighbours already is worth exactly as much as a slot
   * beside a lonely one. The world is allowed to grow a corridor if that is
   * where the dice fall.
   *
   * Maintained incrementally in `bake`. It used to be recomputed here by
   * scanning every sector, which cost ten seconds a claim at a million sectors;
   * the frontier itself only grows as about 7.6·√N.
   */
  openSlots(): Set<CoordKey> {
    return new Set(this.#frontier);
  }

  edges(): Edge[] {
    const present = [...this.#sectors.values()].map((b) => b.sector.coordinate);
    present.sort(coords.compare);
    const found: Edge[] = [];
    for (const coordinate of present) {
      for (const [direction, neighbour] of coords.neighbours(coordinate)) {
        if (this.#sectors.has(coords.key(neighbour))) {
          found.push({
            from: coords.asList(coordinate),
            direction,
            to: coords.asList(neighbour),
          });
        }
      }
    }
    return found;
  }

  // --- objects ------------------------------------------------------------

  addObject(world_object: WorldObject): void {
    if (this.#objects.has(world_object.objectId)) {
      throw new Error(`${world_object.objectId} already exists`);
    }
    this.#objects.set(world_object.objectId, world_object);
    // Objects are created in timestamp order, so appending keeps the
    // oldest-first ordering objectsIn() promises.
    this.#bucketObject(world_object);
    this.#appendRecord("object", objectAsDict(world_object));
  }

  getObject(objectId: string): WorldObject | null {
    return this.#objects.get(objectId) ?? null;
  }

  /**
   * Everything standing in one sector, oldest first.
   *
   * Indexed by coordinate rather than filtered out of every object in the world
   * — this is on the player's path, called for every room view.
   */
  objectsIn(coordinate: Coordinate): WorldObject[] {
    return [...(this.#objectsByCoordinate.get(coords.key(coordinate)) ?? [])];
  }

  childrenOf(parentId: string | null, coordinate: Coordinate): WorldObject[] {
    return this.objectsIn(coordinate).filter((o) => o.parentId === parentId);
  }

  objectCount(): number {
    return this.#objects.size;
  }

  /**
   * Every object in the world, in insertion order.
   *
   * Exists for the tests' reference implementations, which in Python reached
   * into `store._objects` directly. The fields are private here, so the
   * unindexed view has to be offered rather than taken.
   */
  allObjects(): WorldObject[] {
    return [...this.#objects.values()];
  }

  // --- persistence --------------------------------------------------------
  //
  // A compacted snapshot plus an append-only log of everything since. Writing
  // costs one line and one fsync no matter how big the world is; the snapshot
  // used to be rewritten in full on every single contribution, which is half a
  // gigabyte per object at a million sectors.
  //
  // Nothing acknowledged is ever lost. A sector is permanent and an agent waits
  // eight hours per object, so the API must not say "baked" about something a
  // power cut can take back.

  get #logPath(): string {
    return `${this.#path}.log`;
  }

  /**
   * Append one durable record.
   *
   * Deliberately synchronous. Python held a lock across the fsync to serialise
   * writers; Node has no threads to serialise, but an *async* write would
   * reintroduce the same hazard from the other direction — an await here would
   * let a second request interleave between the in-memory mutation above and the
   * fsync below, so a crash could lose a write the API had already acknowledged.
   * At the world's real write rate — one object per agent per eight hours — the
   * blocking cost is nil and correctness is worth more.
   */
  #appendRecord(kind: string, payload: Record<string, unknown>): void {
    if (!this.#path) {
      return;
    }
    if (this.#logFd === null) {
      this.#logFd = openSync(this.#logPath, "a");
    }

    writeSync(this.#logFd, `${JSON.stringify({ t: kind, d: payload })}\n`);
    fsyncSync(this.#logFd);

    this.#logRecords += 1;
    this.#maybeCompact();
  }

  #maybeCompact(): void {
    // Measured against the world size *at the last compaction*, not the current
    // one. Comparing against the current size never fires: every append grows
    // both sides at once, so the log can never catch up.
    const threshold = Math.max(this.#minCompactRecords, this.#compactedSize);
    if (this.#logRecords >= threshold) {
      this.compact();
    }
  }

  /**
   * Fold the log back into the snapshot and start a fresh one.
   *
   * The snapshot is made durable *before* the log is dropped. A crash in between
   * leaves log records that are already in the snapshot, and replay is
   * idempotent, so the worst case is redundant work rather than loss.
   */
  compact(): void {
    if (!this.#path) {
      return;
    }

    const sectorsOut: Record<string, unknown> = {};
    for (const [k, baked] of this.#sectors) {
      sectorsOut[k] = bakedAsDict(baked);
    }
    const objectsOut: Record<string, unknown> = {};
    for (const [id, o] of this.#objects) {
      objectsOut[id] = objectAsDict(o);
    }
    const payload = {
      version: SNAPSHOT_VERSION,
      saved_at: now(),
      sectors: sectorsOut,
      objects: objectsOut,
    };

    const tmp = `${this.#path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(payload, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#path);
    this.#syncDirectory();

    if (this.#logFd !== null) {
      closeSync(this.#logFd);
      this.#logFd = null;
    }
    const truncated = openSync(this.#logPath, "w");
    try {
      fsyncSync(truncated);
    } finally {
      closeSync(truncated);
    }
    this.#logRecords = 0;
    this.#compactedSize = this.#sectors.size + this.#objects.size;
  }

  /** Make the rename itself durable, not just the file contents. */
  #syncDirectory(): void {
    const directory = dirname(resolve(this.#path!)) || ".";
    let fd: number;
    try {
      fd = openSync(directory, "r");
    } catch {
      return; // not every platform allows opening a directory
    }
    try {
      fsyncSync(fd);
    } catch {
      // best effort
    } finally {
      closeSync(fd);
    }
  }

  /** Release the log handle. Everything written is already durable. */
  close(): void {
    if (this.#logFd !== null) {
      closeSync(this.#logFd);
      this.#logFd = null;
    }
  }

  load(): void {
    if (!this.#path) {
      return;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(readFileSync(this.#path, "utf-8")) as Record<string, unknown>;
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== "ENOENT") {
        throw exc;
      }
    }

    const sectors = new Map<CoordKey, BakedSector>();
    for (const [k, value] of Object.entries(
      (payload["sectors"] as Record<string, Record<string, unknown>>) ?? {},
    )) {
      // Round-trip the key so a malformed one is caught here, not much later.
      sectors.set(coords.key(coords.fromKey(k)), bakedFromDict(value));
    }
    const objects = new Map<string, WorldObject>();
    for (const [id, value] of Object.entries(
      (payload["objects"] as Record<string, Record<string, unknown>>) ?? {},
    )) {
      objects.set(id, objectFromDict(value));
    }
    const replayed = this.#replayLog(sectors, objects);

    this.#sectors = sectors;
    this.#objects = objects;
    this.#logRecords = replayed;
    this.#compactedSize = sectors.size + objects.size - replayed;
    this.#rebuildIndexes();
    this.#maybeCompact();
  }

  /** Apply everything written since the snapshot. Idempotent by design. */
  #replayLog(sectors: Map<CoordKey, BakedSector>, objects: Map<string, WorldObject>): number {
    let raw: string;
    try {
      raw = readFileSync(this.#logPath, "utf-8");
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw exc;
    }

    // A trailing newline is not a record. Python's readlines() produced no
    // final empty element for it, and splitting naively would invent one.
    const lines = raw.split("\n");
    if (lines.length && lines[lines.length - 1] === "") {
      lines.pop();
    }

    let replayed = 0;
    for (const [index, line] of lines.entries()) {
      try {
        const record = JSON.parse(line) as { t?: unknown; d?: unknown };
        const kind = record.t;
        const data = record.d as Record<string, unknown>;
        if (kind === "sector") {
          const baked = bakedFromDict(data);
          sectors.set(coords.key(baked.sector.coordinate), baked);
        } else if (kind === "object") {
          const world_object = objectFromDict(data);
          objects.set(world_object.objectId, world_object);
        } else {
          throw new Error(`unknown record type ${JSON.stringify(kind)}`);
        }
      } catch (exc) {
        if (index === lines.length - 1) {
          // A crash mid-append leaves a torn final line. Every line before it
          // was fsynced; this one was never acknowledged to the agent, so
          // dropping it loses nothing anybody was told.
          break;
        }
        // A break in the middle is real corruption, and silently skipping it
        // would quietly lose somebody's permanent sector.
        throw new Error(
          `${this.#logPath} is corrupt at line ${index + 1}: ${(exc as Error).message}`,
        );
      }
      replayed += 1;
    }
    return replayed;
  }
}

/**
 * Raised when a sector would be rewritten. Its own class so the engine can tell
 * it from any other failure — Python caught `KeyError`, which in JavaScript has
 * no equivalent that is safe to match on.
 */
export class AlreadyBaked extends Error {}

/**
 * Seconds since the epoch, as a float.
 *
 * Python's `time.time()` spelling, kept deliberately: the snapshot stores these
 * verbatim, so switching to milliseconds would make every existing `world.json`
 * unreadable and every timestamp in the API 1000× too large.
 */
export function now(): number {
  return Date.now() / 1000;
}
