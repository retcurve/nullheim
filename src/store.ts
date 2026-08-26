/**
 * World persistence: sectors and objects, backed by SQL.
 *
 * Sectors are nodes on a flat lattice, keyed by coordinate rather than a
 * synthetic id — the schema comment in `db/schema.sql` says why. Exits are
 * *not* stored — they are derived from adjacency every time they are asked
 * for, which is why no two neighbouring agents can ever disagree about a
 * doorway. Objects hang off sectors and off each other in a tree.
 *
 * Every method here is async: the same store runs against a local SQLite
 * file (node:sqlite, effectively synchronous under the hood) and against
 * Cloudflare D1 (a real network round trip), and nothing in this module may
 * assume which. See `db.ts` for what that buys and what it costs — in
 * particular, why `bake()` is one `batch()` call rather than a read followed
 * by a write.
 */

import * as coords from "./coords.ts";
import type { CoordKey, Coordinate, Direction } from "./coords.ts";
import { isUniqueViolation, type Db, type Statement } from "./db.ts";
import { sectorAsDict, type Sector } from "./schema.ts";

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

interface SectorRow {
  x: number;
  y: number;
  sector_id: string;
  agent_id: string;
  title: string;
  short_description: string;
  long_description: string;
  baked_at: number;
}

function rowToBaked(row: SectorRow): BakedSector {
  return {
    sector: {
      coordinate: coords.coord(row.x, row.y),
      title: row.title,
      shortDescription: row.short_description,
      longDescription: row.long_description,
    },
    sectorId: row.sector_id,
    agentId: row.agent_id,
    bakedAt: row.baked_at,
  };
}

interface ObjectRow {
  object_id: string;
  x: number;
  y: number;
  parent_id: string | null;
  title: string;
  description: string;
  agent_id: string;
  created_at: number;
}

function rowToObject(row: ObjectRow): WorldObject {
  return {
    objectId: row.object_id,
    coordinate: coords.coord(row.x, row.y),
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

/** SQL-backed world: sectors, objects, and the frontier index. */
export class WorldStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // --- sectors ------------------------------------------------------------

  async get(coordinate: Coordinate): Promise<BakedSector | null> {
    const row = await this.#db.first<SectorRow>("SELECT * FROM sectors WHERE x = ? AND y = ?", [
      coordinate.x,
      coordinate.y,
    ]);
    return row === null ? null : rowToBaked(row);
  }

  async getById(sectorId: string): Promise<BakedSector | null> {
    const row = await this.#db.first<SectorRow>("SELECT * FROM sectors WHERE sector_id = ?", [
      sectorId,
    ]);
    return row === null ? null : rowToBaked(row);
  }

  /**
   * Write a sector permanently and fold it into the frontier, atomically.
   *
   * The static lock and the frontier update ride in one `batch()`: the
   * sector insert either succeeds or collides with the `(x, y)` primary key
   * (a concurrent bake of the same coordinate, or a genuine rewrite attempt),
   * and either way the frontier statements below it must not run on their
   * own — a frontier update with no matching sector would corrupt the index.
   *
   * Exactly five coordinates can change: the one just filled, no longer a
   * frontier slot, and its four neighbours, any of which may now touch the
   * world for the first time. Each neighbour insert is itself conditional
   * (`WHERE NOT EXISTS (… sectors …)`) so a neighbour that is already baked
   * is never re-added — the read and the write are one statement, not two,
   * which is what keeps this race-free under concurrent claims.
   */
  async bake(baked: BakedSector): Promise<void> {
    const { x, y } = baked.sector.coordinate;
    const statements: Statement[] = [
      {
        sql:
          "INSERT INTO sectors (x, y, sector_id, agent_id, title, short_description, " +
          "long_description, baked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          x,
          y,
          baked.sectorId,
          baked.agentId,
          baked.sector.title,
          baked.sector.shortDescription,
          baked.sector.longDescription,
          baked.bakedAt,
        ],
      },
      { sql: "DELETE FROM frontier WHERE x = ? AND y = ?", params: [x, y] },
    ];
    for (const [, neighbour] of coords.neighbours(baked.sector.coordinate)) {
      if (!coords.inBounds(neighbour)) {
        continue;
      }
      statements.push({
        sql:
          "INSERT OR IGNORE INTO frontier (x, y) SELECT ?, ? " +
          "WHERE NOT EXISTS (SELECT 1 FROM sectors WHERE x = ? AND y = ?)",
        params: [neighbour.x, neighbour.y, neighbour.x, neighbour.y],
      });
    }

    try {
      await this.#db.batch(statements);
    } catch (exc) {
      if (isUniqueViolation(exc)) {
        throw new AlreadyBaked(
          `${coords.toString(baked.sector.coordinate)} is already baked and cannot be rewritten`,
        );
      }
      throw exc;
    }
  }

  async sectors(): Promise<BakedSector[]> {
    const rows = await this.#db.all<SectorRow>("SELECT * FROM sectors");
    return rows.map(rowToBaked);
  }

  async count(): Promise<number> {
    const row = await this.#db.first<{ c: number }>("SELECT COUNT(*) AS c FROM sectors");
    return row?.c ?? 0;
  }

  async isBaked(coordinate: Coordinate): Promise<boolean> {
    const row = await this.#db.first(
      "SELECT 1 FROM sectors WHERE x = ? AND y = ? LIMIT 1",
      [coordinate.x, coordinate.y],
    );
    return row !== null;
  }

  // --- derived exits ------------------------------------------------------

  /**
   * Every side with a neighbour is an exit. Nobody declares these.
   *
   * The label a player reads on the door is the neighbour's own `title`, and
   * examining the door without walking through shows the neighbour's
   * `shortDescription`. So each sector writes the sign on the outside of its
   * own front door, and its neighbours never get a say — which is how two
   * rooms that agree on nothing still join up cleanly.
   */
  async exitsFrom(coordinate: Coordinate): Promise<Exit[]> {
    const entries = coords.neighbours(coordinate);
    const neighbours = await Promise.all(entries.map(([, neighbour]) => this.get(neighbour)));
    const found: Exit[] = [];
    for (const [index, [direction, neighbourCoord]] of entries.entries()) {
      const baked = neighbours[index]!;
      if (baked === null) {
        continue;
      }
      found.push({
        direction,
        name: baked.sector.title,
        description: baked.sector.shortDescription,
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
   * Backed by the `frontier` table, maintained incrementally in `bake()`. A
   * query that scanned every sector to answer this was measured at 213ms a
   * claim at 20k sectors; the frontier itself only grows as about 7.6·√N.
   */
  async openSlots(): Promise<Set<CoordKey>> {
    const rows = await this.#db.all<{ x: number; y: number }>("SELECT x, y FROM frontier");
    return new Set(rows.map((r) => coords.key(coords.coord(r.x, r.y))));
  }

  async edges(): Promise<Edge[]> {
    const rows = await this.#db.all<{ x: number; y: number }>("SELECT x, y FROM sectors");
    const present = rows.map((r) => coords.coord(r.x, r.y)).sort(coords.compare);
    const baked = new Set(present.map(coords.key));
    const found: Edge[] = [];
    for (const coordinate of present) {
      for (const [direction, neighbour] of coords.neighbours(coordinate)) {
        if (baked.has(coords.key(neighbour))) {
          found.push({ from: coords.asList(coordinate), direction, to: coords.asList(neighbour) });
        }
      }
    }
    return found;
  }

  // --- objects ------------------------------------------------------------

  async addObject(o: WorldObject): Promise<void> {
    try {
      await this.#db.run(
        "INSERT INTO objects (object_id, x, y, parent_id, title, description, agent_id, " +
          "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          o.objectId,
          o.coordinate.x,
          o.coordinate.y,
          o.parentId,
          o.title,
          o.description,
          o.agentId,
          o.createdAt,
        ],
      );
    } catch (exc) {
      if (isUniqueViolation(exc)) {
        throw new Error(`${o.objectId} already exists`);
      }
      throw exc;
    }
  }

  async getObject(objectId: string): Promise<WorldObject | null> {
    const row = await this.#db.first<ObjectRow>("SELECT * FROM objects WHERE object_id = ?", [
      objectId,
    ]);
    return row === null ? null : rowToObject(row);
  }

  /**
   * Everything standing in one sector, oldest first.
   *
   * Indexed by coordinate rather than filtered out of every object in the
   * world — this is on the player's path, called for every room view.
   */
  async objectsIn(coordinate: Coordinate): Promise<WorldObject[]> {
    const rows = await this.#db.all<ObjectRow>(
      "SELECT * FROM objects WHERE x = ? AND y = ? ORDER BY created_at ASC",
      [coordinate.x, coordinate.y],
    );
    return rows.map(rowToObject);
  }

  async childrenOf(parentId: string | null, coordinate: Coordinate): Promise<WorldObject[]> {
    return (await this.objectsIn(coordinate)).filter((o) => o.parentId === parentId);
  }

  async objectCount(): Promise<number> {
    const row = await this.#db.first<{ c: number }>("SELECT COUNT(*) AS c FROM objects");
    return row?.c ?? 0;
  }

  /**
   * Every object in the world, in creation order.
   *
   * Exists for tests that need to check the whole store's contents directly,
   * and to compare the coordinate index against a full scan.
   */
  async allObjects(): Promise<WorldObject[]> {
    const rows = await this.#db.all<ObjectRow>("SELECT * FROM objects ORDER BY created_at ASC");
    return rows.map(rowToObject);
  }
}

/**
 * Raised when a sector would be rewritten. Its own class so the engine can
 * tell it from any other failure.
 */
export class AlreadyBaked extends Error {}

/**
 * Seconds since the epoch, as a float.
 *
 * Kept as this app's one timestamp spelling throughout — sectors, objects,
 * claims and agents all store it this way, so a REAL column holds it without
 * conversion at either end.
 */
export function now(): number {
  return Date.now() / 1000;
}
