/**
 * World persistence: sectors and objects, backed by SQL.
 *
 * Sectors are keyed by coordinate. Exits are not stored; they are computed
 * from adjacency whenever they are read. Objects form a tree, attached to
 * sectors and to each other.
 *
 * Every method here is async, so the same store works against a local
 * SQLite file or Cloudflare D1.
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
 * A written `use A with B` interaction. `objectAId` and `objectBId` are
 * always stored with the lexicographically smaller object id first.
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

/** Returns the two object ids in (smaller, larger) order. */
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

/** Extracts the bare key from a `/v1/images/{key}` url. */
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

/** Stores sectors, objects, and the frontier index in SQL. */
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

  /** Returns whether a sector references this image url. */
  async imageIsReferenced(url: string): Promise<boolean> {
    return (await this.#db.first("SELECT 1 FROM sectors WHERE image = ? LIMIT 1", [url])) !== null;
  }

  // --- image moderation -----------------------------------------------------

  /** Records a freshly uploaded image's verdict: `published` or `pending`. */
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

  /** Returns whether a stored image may be served. A missing row counts as published. */
  async imageIsPublished(key: string): Promise<boolean> {
    const row = await this.#db.first<{ state: ImageModerationState }>(
      "SELECT state FROM images WHERE image_key = ?",
      [key],
    );
    return row === null || row.state === "published";
  }

  /** Returns images in the given state, oldest first, or every image if `state` is omitted. */
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

  /** Marks a `pending` image as published. Returns false if it was not pending. */
  async approveImage(key: string): Promise<boolean> {
    const result = await this.#db.run(
      "UPDATE images SET state = 'published', reviewed_at = ? WHERE image_key = ? AND state = 'pending'",
      [now(), key],
    );
    return result.changes > 0;
  }

  /**
   * Marks an image rejected and clears it from any sector showing it.
   * Returns false if there was no such image.
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

  /**
   * Writes a sector permanently and updates the frontier in one atomic
   * batch: removes the sector's own coordinate from the frontier and adds
   * any of its neighbours not already baked. If `claimId` is given, the
   * insert only runs while that claim is still open and unexpired.
   */
  async bake(baked: BakedSector, claimId: string | null): Promise<void> {
    const { x, y } = baked.sector.coordinate;
    const statements: Statement[] = [
      {
        // Only inserts while the named claim is still open and unexpired,
        // when claimId is given.
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
    // No rows changed means the claim guard did not match.
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
   * Returns one exit for each neighbouring coordinate that is baked, labelled
   * with that neighbour's own title and short description.
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

  /** Returns the unbaked, in-bounds coordinates that touch at least one baked sector. */
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

  /** Returns every object standing in one sector, oldest first. */
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

  /** Counts objects in one sector, without fetching them. */
  async objectCountIn(coordinate: Coordinate): Promise<number> {
    const row = await this.#db.first<{ c: number }>(
      "SELECT COUNT(*) AS c FROM objects WHERE x = ? AND y = ?",
      [coordinate.x, coordinate.y],
    );
    return row?.c ?? 0;
  }

  /** Returns every object in the world, in creation order. */
  async allObjects(): Promise<WorldObject[]> {
    const rows = await this.#db.all<ObjectRow>("SELECT * FROM objects ORDER BY created_at ASC");
    return rows.map(rowToObject);
  }

  // --- interactions ---------------------------------------------------------

  /** Writes one `use A with B` interaction, normalising the object ids to canonical order. */
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

/** Raised when a sector would be rewritten. */
export class AlreadyBaked extends Error {}

/** Raised when a claim was no longer live when the sector insert ran. */
export class ClaimNotLive extends Error {}

/** Returns the current time in seconds since the epoch, as a float. */
export function now(): number {
  return Date.now() / 1000;
}
