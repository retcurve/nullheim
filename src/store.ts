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
  readonly image: string | null;
  readonly useText: string | null;
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
    image: o.image,
    use_text: o.useText,
    agent_id: o.agentId,
    created_at: o.createdAt,
  };
}

/**
 * A written `use A with B` interaction. `objectAId`/`objectBId` are always
 * stored with the lexicographically smaller object id first (see
 * `pairKey()`), so a lookup never has to try both orderings.
 */
export interface Interaction {
  readonly interactionId: string;
  readonly objectAId: string;
  readonly objectBId: string;
  readonly text: string;
  readonly agentId: string;
  readonly createdAt: number;
}

export function interactionAsDict(i: Interaction): Record<string, unknown> {
  return {
    interaction_id: i.interactionId,
    object_a_id: i.objectAId,
    object_b_id: i.objectBId,
    text: i.text,
    agent_id: i.agentId,
    created_at: i.createdAt,
  };
}

/** The canonical (smaller, larger) ordering every interaction is stored and looked up by. */
export function pairKey(objectAId: string, objectBId: string): [string, string] {
  return objectAId < objectBId ? [objectAId, objectBId] : [objectBId, objectAId];
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
  image: string | null;
  baked_at: number;
}

function rowToBaked(row: SectorRow): BakedSector {
  return {
    sector: {
      coordinate: coords.coord(row.x, row.y),
      title: row.title,
      shortDescription: row.short_description,
      longDescription: row.long_description,
      image: row.image,
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
  image: string | null;
  use_text: string | null;
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
    image: row.image,
    useText: row.use_text,
    agentId: row.agent_id,
    createdAt: row.created_at,
  };
}

export type ImageModerationState = "published" | "pending" | "rejected";

export interface ModeratedImage {
  readonly imageKey: string;
  readonly claimId: string;
  readonly state: ImageModerationState;
  readonly score: number | null;
  readonly createdAt: number;
  readonly reviewedAt: number | null;
}

interface ImageRow {
  image_key: string;
  claim_id: string;
  state: ImageModerationState;
  score: number | null;
  created_at: number;
  reviewed_at: number | null;
}

function rowToModeratedImage(row: ImageRow): ModeratedImage {
  return {
    imageKey: row.image_key,
    claimId: row.claim_id,
    state: row.state,
    score: row.score,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/** The bare key a `/v1/images/{key}` url was built from — the shape `images.image_key` and `claims.image_key` are both keyed by. */
export function imageKeyFromUrl(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

interface InteractionRow {
  interaction_id: string;
  object_a_id: string;
  object_b_id: string;
  text: string;
  agent_id: string;
  created_at: number;
}

function rowToInteraction(row: InteractionRow): Interaction {
  return {
    interactionId: row.interaction_id,
    objectAId: row.object_a_id,
    objectBId: row.object_b_id,
    text: row.text,
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
  /**
   * Is this image url referenced by a sector?
   *
   * Which is the same as asking whether it is permanent: a sector can never
   * be rewritten, so an image it shows can never stop being shown — and the
   * reaper refuses to delete one, for that reason. An unreferenced image is
   * either still in flight or already garbage, and either way may be gone
   * within the minute.
   */
  async imageIsReferenced(url: string): Promise<boolean> {
    return (await this.#db.first("SELECT 1 FROM sectors WHERE image = ? LIMIT 1", [url])) !== null;
  }

  // --- image moderation -----------------------------------------------------

  /**
   * Record a freshly uploaded image's verdict — `published` for clean,
   * `pending` for unsure. Never `rejected`: nothing here writes that state
   * automatically, only a human does, through `rejectImage` below. See
   * `moderation.ts`'s module comment for why there is no automated third
   * verdict that skips storing the image at all.
   */
  async recordImage(
    key: string,
    claimId: string,
    state: "published" | "pending",
    score: number | null,
  ): Promise<void> {
    await this.#db.run(
      "INSERT INTO images (image_key, claim_id, state, score, created_at) VALUES (?, ?, ?, ?, ?)",
      [key, claimId, state, score, now()],
    );
  }

  /**
   * Whether a stored image may be served. A missing row is treated as
   * published: every upload since this table existed writes one in the same
   * request that writes the blob, so a missing row only ever means an image
   * that predates moderation — which was already public before this shipped,
   * and 404ing it now would be a regression, not a safety improvement.
   */
  async imageIsPublished(key: string): Promise<boolean> {
    const row = await this.#db.first<{ state: ImageModerationState }>(
      "SELECT state FROM images WHERE image_key = ?",
      [key],
    );
    return row === null || row.state === "published";
  }

  /** The review queue, oldest first — every state if `state` is omitted. */
  async listImages(state?: ImageModerationState): Promise<ModeratedImage[]> {
    const rows =
      state === undefined
        ? await this.#db.all<ImageRow>("SELECT * FROM images ORDER BY created_at ASC")
        : await this.#db.all<ImageRow>(
            "SELECT * FROM images WHERE state = ? ORDER BY created_at ASC",
            [state],
          );
    return rows.map(rowToModeratedImage);
  }

  /** A human clears a `pending` image to show. False if it wasn't pending (including if there is no such image at all). */
  async approveImage(key: string): Promise<boolean> {
    const result = await this.#db.run(
      "UPDATE images SET state = 'published', reviewed_at = ? WHERE image_key = ? AND state = 'pending'",
      [now(), key],
    );
    return result.changes > 0;
  }

  /**
   * A human refuses an image, whatever state it was in — including one a
   * sector already shows. This is this world's only takedown path (see
   * CLAUDE.md): both statements ride one `batch()` so a sector never ends up
   * showing a url this table calls rejected, or vice versa. Returns false if
   * there was no such image at all; the caller still owes an `ImageStore`
   * delete either way, since a blob can exist with no row (one uploaded
   * before this table did).
   */
  async rejectImage(key: string): Promise<boolean> {
    const url = `/v1/images/${key}`;
    const results = await this.#db.batch([
      {
        sql: "UPDATE images SET state = 'rejected', reviewed_at = ? WHERE image_key = ?",
        params: [now(), key],
      },
      { sql: "UPDATE sectors SET image = NULL WHERE image = ?", params: [url] },
    ]);
    return results[0]!.changes > 0;
  }

  async bake(baked: BakedSector, claimId: string | null): Promise<void> {
    const { x, y } = baked.sector.coordinate;
    const statements: Statement[] = [
      {
        // Conditional on the claim still being live, in the same statement as
        // the write. The caller checked that already, but a check followed by
        // a separate write is exactly the shape this file avoids everywhere
        // else: a lease can lapse during the validation pass in between, and a
        // sector baked on a dead lease is a sector on a coordinate the world
        // has already offered to somebody else — and, since 0007, one whose
        // image the reaper may have decided was garbage.
        //
        // `claimId` is null only for a sector the system authors — genesis,
        // and the direct bakes tests use to lay out a world. Those answer to
        // no lease, so there is nothing to re-check.
        sql:
          "INSERT INTO sectors (x, y, sector_id, agent_id, title, short_description, " +
          "long_description, image, baked_at) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?" +
          (claimId === null
            ? ""
            : " WHERE EXISTS (" +
              "  SELECT 1 FROM claims WHERE claim_id = ? AND status = 'open' AND expires_at > ?" +
              ")"),
        params: [
          x,
          y,
          baked.sectorId,
          baked.agentId,
          baked.sector.title,
          baked.sector.shortDescription,
          baked.sector.longDescription,
          baked.sector.image,
          baked.bakedAt,
          ...(claimId === null ? [] : [claimId, baked.bakedAt]),
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

    let results;
    try {
      results = await this.#db.batch(statements);
    } catch (exc) {
      if (isUniqueViolation(exc)) {
        throw new AlreadyBaked(
          `${coords.toString(baked.sector.coordinate)} is already baked and cannot be rewritten`,
        );
      }
      throw exc;
    }
    // A taken coordinate raises above; an insert that simply matched nothing
    // means the guard failed, which can only be the claim.
    if (results[0]!.changes === 0) {
      throw new ClaimNotLive(`claim ${claimId} is no longer live, so nothing was baked`);
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
        "INSERT INTO objects (object_id, x, y, parent_id, title, description, image, " +
          "use_text, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          o.objectId,
          o.coordinate.x,
          o.coordinate.y,
          o.parentId,
          o.title,
          o.description,
          o.image,
          o.useText,
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
   * How many objects stand in one sector, without fetching them.
   *
   * Rides the same coordinate index as `objectsIn()`, so an agent's `/me`
   * index can report every held sector's size without ever pulling the rows
   * themselves — the count is O(1) per sector regardless of how many objects
   * it holds.
   */
  async objectCountIn(coordinate: Coordinate): Promise<number> {
    const row = await this.#db.first<{ c: number }>(
      "SELECT COUNT(*) AS c FROM objects WHERE x = ? AND y = ?",
      [coordinate.x, coordinate.y],
    );
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

  // --- interactions ---------------------------------------------------------

  /**
   * Write one `use A with B` interaction, permanently.
   *
   * Ids are normalised to `pairKey()`'s canonical order before the insert,
   * so `idx_interactions_pair`'s uniqueness catches a duplicate regardless
   * of which order the caller happened to name the two objects in.
   */
  async addInteraction(i: Interaction): Promise<void> {
    const [objectAId, objectBId] = pairKey(i.objectAId, i.objectBId);
    try {
      await this.#db.run(
        "INSERT INTO interactions (interaction_id, object_a_id, object_b_id, text, " +
          "agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [i.interactionId, objectAId, objectBId, i.text, i.agentId, i.createdAt],
      );
    } catch (exc) {
      if (isUniqueViolation(exc)) {
        throw new Error(`${objectAId} and ${objectBId} already have an interaction`);
      }
      throw exc;
    }
  }

  /** The interaction between two objects, in either order, or null if there isn't one. */
  async interactionBetween(objectAId: string, objectBId: string): Promise<Interaction | null> {
    const [a, b] = pairKey(objectAId, objectBId);
    const row = await this.#db.first<InteractionRow>(
      "SELECT * FROM interactions WHERE object_a_id = ? AND object_b_id = ?",
      [a, b],
    );
    return row === null ? null : rowToInteraction(row);
  }

  async interactionExists(objectAId: string, objectBId: string): Promise<boolean> {
    const [a, b] = pairKey(objectAId, objectBId);
    const row = await this.#db.first(
      "SELECT 1 FROM interactions WHERE object_a_id = ? AND object_b_id = ? LIMIT 1",
      [a, b],
    );
    return row !== null;
  }
}

/**
 * Raised when a sector would be rewritten. Its own class so the engine can
 * tell it from any other failure.
 */
export class AlreadyBaked extends Error {}

/**
 * The claim was no longer live when the sector insert ran.
 *
 * Distinct from `AlreadyBaked`, which is about the *coordinate*. This one is
 * about the lease: a submission checks its claim is active on the way in and
 * then does a validation pass before writing, so the lease can lapse in
 * between. The insert re-checks it in the same statement rather than trusting
 * that read — see `bake()`.
 */
export class ClaimNotLive extends Error {}

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
