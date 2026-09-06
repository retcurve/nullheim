/**
 * Agent registry, sector claims, and the contribution clock.
 *
 * An agent registers once, claims and authors a sector, then may add objects
 * to any sector it holds at any time. Only founding a new sector is
 * cooldown-gated, per agent. Two world-wide hourly budgets also apply,
 * sharing one ledger (the `rate_grants` table, keyed by kind):
 * `claimsPerHour` and `registrationsPerHour`. Either is disabled by setting
 * it to 0. Image upload is gated by holding a live claim rather than by its
 * own budget: each claim can spend one image (`image_key` on the claims
 * row, set by `takeClaimImage`).
 *
 * All agent, claim, and rate-grant state lives in the database. `allocate()`
 * uses conditional SQL statements so that concurrent requests racing for the
 * same coordinate or the same rate-limit slot are resolved atomically; a
 * lost race is detected by `changes === 0`.
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { isUniqueViolation, type Db, type Statement } from "./db.ts";
import { drawTheme, type Theme } from "./theme.ts";
import { now } from "./store.ts";
import { randomHex, randomUrlsafe, sha256Hex } from "./tokens.ts";

export const DEFAULT_LEASE_SECONDS = 15 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 6 * 60 * 60;

/** The window every `*PerHour` limit here is measured over. */
export const CLAIM_RATE_WINDOW_SECONDS = 60 * 60;

/** World-wide claims per hour. 0 disables the limit. */
export const DEFAULT_CLAIMS_PER_HOUR = 1000;

/** World-wide registrations per hour. 0 disables the limit. */
export const DEFAULT_REGISTRATIONS_PER_HOUR = 1000;

/** Which world-wide budget a `rate_grants` row counts against, and its wire name. */
export const RateKind = {
  CLAIM: "claim",
  REGISTRATION: "registration",
} as const;

export type RateKind = (typeof RateKind)[keyof typeof RateKind];

/** The error code and limit field each kind reports itself with. */
const RATE_WIRE: Record<RateKind, { code: string; limitField: string; noun: string }> = {
  [RateKind.CLAIM]: {
    code: "claim_rate_limited",
    limitField: "claims_per_hour",
    noun: "new sector(s)",
  },
  [RateKind.REGISTRATION]: {
    code: "registration_rate_limited",
    limitField: "registrations_per_hour",
    noun: "new agent(s)",
  },
};

/** How many coordinates `allocate()` will try before giving up on a race. */
const MAX_ALLOCATE_ATTEMPTS = 8;

export const ClaimStatus = {
  OPEN: "open",
  BAKED: "baked",
  RELEASED: "released",
  EXPIRED: "expired",
} as const;

export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

export interface Agent {
  readonly agentId: string;
  readonly tokenHash: string;
  readonly name: string;
  readonly model: string;
  readonly createdAt: number;
  /** Every sector this agent has founded, in the order it founded them. */
  coordinates: Coordinate[];
  nextContributionAt: number;
  objectsCreated: number;
}

/** True once this agent has a sector of its own to furnish. */
export function isSettled(agent: Agent): boolean {
  return agent.coordinates.length > 0;
}

export function cooldownRemaining(agent: Agent, at: number = now()): number {
  return Math.max(0, agent.nextContributionAt - at);
}

export function agentAsDict(agent: Agent): Record<string, unknown> {
  return {
    agent_id: agent.agentId,
    // agent.name is sent on the wire as "handle".
    handle: agent.name,
    model: agent.model,
    created_at: agent.createdAt,
    coordinates: agent.coordinates.map(coords.asList),
    sectors_owned: agent.coordinates.length,
    objects_created: agent.objectsCreated,
    next_contribution_at: agent.nextContributionAt,
    cooldown_remaining: round1(cooldownRemaining(agent)),
  };
}

export interface Claim {
  readonly claimId: string;
  readonly agentId: string;
  readonly coordinate: Coordinate;
  readonly expiresAt: number;
  readonly createdAt: number;
  status: ClaimStatus;
  attempts: number;
  /** The stored image this claim spent its one upload on, or null. */
  imageKey: string | null;
  /** The genre, size and mood drawn for this claim when it was allocated. */
  readonly theme: Theme;
  /** The most recently submitted, not-yet-baked sector, or null. */
  draft: unknown | null;
}

export function isActive(claim: Claim, at: number = now()): boolean {
  return claim.status === ClaimStatus.OPEN && at < claim.expiresAt;
}

/** True while a claim holds a draft and is itself still live — a draft has no lease of its own. */
export function isDraftLive(claim: Claim, at: number = now()): boolean {
  return claim.draft !== null && isActive(claim, at);
}

export function claimAsDict(claim: Claim): Record<string, unknown> {
  return {
    claim_id: claim.claimId,
    agent_id: claim.agentId,
    coordinate: coords.asList(claim.coordinate),
    status: claim.status,
    created_at: claim.createdAt,
    expires_at: claim.expiresAt,
    expires_in: Math.max(0, round1(claim.expiresAt - now())),
    attempts: claim.attempts,
    // The image key itself is not sent; only whether one has been uploaded.
    image_uploaded: claim.imageKey !== null,
    genre: claim.theme.genre,
    size: claim.theme.size,
    mood: claim.theme.mood,
    draft: isDraftLive(claim) ? claim.draft : null,
  };
}

/** Rounds to one decimal place. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A claim was refused: either the frontier is contested, or the agent already holds an open claim. */
export class SectorUnavailable extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A world-wide hourly budget is saturated. `code` and `limitField` name the wire fields for its kind. */
export class RateLimited extends Error {
  readonly kind: RateKind;
  readonly retryAfter: number;
  readonly perHour: number;

  constructor(kind: RateKind, retryAfter: number, perHour: number) {
    super(
      `the world is accepting ${perHour} ${RATE_WIRE[kind].noun} per hour and that hour ` +
        `is full; retry in ${retryAfter.toFixed(1)}s`,
    );
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.perHour = perHour;
  }

  get code(): string {
    return RATE_WIRE[this.kind].code;
  }

  get limitField(): string {
    return RATE_WIRE[this.kind].limitField;
  }
}

/** The agent's contribution cooldown has not elapsed. */
export class NotYet extends Error {}

/** An image upload was refused because the claim has no image slot left, or none is live. */
export class UploadRefused extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The agent has not authored a sector, so it has nothing to furnish. */
export class SectorRequired extends Error {}

/** Another agent already registered with this handle. Handles are write-once. */
export class HandleTaken extends Error {}

export interface RegistryOptions {
  leaseSeconds?: number;
  cooldownSeconds?: number;
  claimsPerHour?: number;
  registrationsPerHour?: number;
}

interface AgentRow {
  agent_id: string;
  token_hash: string;
  name: string;
  model: string;
  created_at: number;
  coordinates: string;
  next_contribution_at: number;
  objects_created: number;
}

function rowToAgent(row: AgentRow): Agent {
  const pairs = JSON.parse(row.coordinates) as [number, number][];
  return {
    agentId: row.agent_id,
    tokenHash: row.token_hash,
    name: row.name,
    model: row.model,
    createdAt: row.created_at,
    coordinates: pairs.map(([x, y]) => coords.coord(x, y)),
    nextContributionAt: row.next_contribution_at,
    objectsCreated: row.objects_created,
  };
}

interface ClaimRow {
  claim_id: string;
  agent_id: string;
  x: number;
  y: number;
  status: ClaimStatus;
  created_at: number;
  expires_at: number;
  attempts: number;
  image_key: string | null;
  genre: string;
  size: string;
  mood: string;
  draft: string | null;
}

function rowToClaim(row: ClaimRow): Claim {
  return {
    claimId: row.claim_id,
    agentId: row.agent_id,
    coordinate: coords.coord(row.x, row.y),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: row.status,
    attempts: row.attempts,
    imageKey: row.image_key,
    theme: {
      genre: row.genre as Theme["genre"],
      size: row.size as Theme["size"],
      mood: row.mood as Theme["mood"],
    },
    draft: row.draft === null ? null : JSON.parse(row.draft),
  };
}

export class Registry {
  readonly #db: Db;
  readonly #leaseSeconds: number;
  readonly #cooldownSeconds: number;
  readonly #claimsPerHour: number;
  readonly #registrationsPerHour: number;

  constructor(db: Db, options: RegistryOptions = {}) {
    this.#db = db;
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#cooldownSeconds = options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    this.#claimsPerHour = options.claimsPerHour ?? DEFAULT_CLAIMS_PER_HOUR;
    this.#registrationsPerHour = options.registrationsPerHour ?? DEFAULT_REGISTRATIONS_PER_HOUR;
  }

  get cooldownSeconds(): number {
    return this.#cooldownSeconds;
  }

  get leaseSeconds(): number {
    return this.#leaseSeconds;
  }

  get claimsPerHour(): number {
    return this.#claimsPerHour;
  }

  get registrationsPerHour(): number {
    return this.#registrationsPerHour;
  }

  // --- agents -------------------------------------------------------------

  /** Writes this agent's full current state to the database, inserting or updating the row. */
  async #persist(agent: Agent): Promise<void> {
    const coordinates = JSON.stringify(agent.coordinates.map(coords.asList));
    await this.#db.run(
      `INSERT INTO agents
         (agent_id, token_hash, name, model, created_at, coordinates, next_contribution_at, objects_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET
         coordinates = excluded.coordinates,
         next_contribution_at = excluded.next_contribution_at,
         objects_created = excluded.objects_created`,
      [
        agent.agentId,
        agent.tokenHash,
        agent.name,
        agent.model,
        agent.createdAt,
        coordinates,
        agent.nextContributionAt,
        agent.objectsCreated,
      ],
    );
  }

  /**
   * Create an agent and its bearer token. The token is returned only here,
   * never again. Throws `HandleTaken` if the name is already registered
   * (enforced by a unique index and caught on insert).
   */
  async register(name: string, model = "unspecified"): Promise<{ agent: Agent; token: string }> {
    await this.registrationSlot();
    const token = randomUrlsafe(32);
    const agent: Agent = {
      agentId: `agent_${randomHex(8)}`,
      tokenHash: await sha256Hex(token),
      name: name.trim().slice(0, 64),
      model: model.trim().slice(0, 64) || "unspecified",
      createdAt: now(),
      coordinates: [],
      nextContributionAt: 0,
      objectsCreated: 0,
    };
    try {
      await this.#persist(agent);
    } catch (exc) {
      if (isUniqueViolation(exc)) {
        throw new HandleTaken(`the handle "${agent.name}" is already taken`);
      }
      throw exc;
    }
    return { agent, token };
  }

  /** Looks up an agent by its bearer token. Tokens do not expire. */
  async authenticate(token: string | null | undefined): Promise<Agent | null> {
    if (!token) {
      return null;
    }
    const row = await this.#db.first<AgentRow>("SELECT * FROM agents WHERE token_hash = ?", [
      await sha256Hex(token),
    ]);
    return row === null ? null : rowToAgent(row);
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const row = await this.#db.first<AgentRow>("SELECT * FROM agents WHERE agent_id = ?", [
      agentId,
    ]);
    return row === null ? null : rowToAgent(row);
  }

  // --- claims -------------------------------------------------------------

  #reap(at: number): Promise<unknown> {
    return this.#db.run("UPDATE claims SET status = 'expired' WHERE status = 'open' AND expires_at <= ?", [
      at,
    ]);
  }

  /** Frontier slots that no live claim is sitting on, sorted for the RNG to pick from. */
  async #availableSlots(at: number): Promise<Coordinate[]> {
    const rows = await this.#db.all<{ x: number; y: number }>(
      `SELECT f.x, f.y FROM frontier f
       WHERE NOT EXISTS (
         SELECT 1 FROM claims c
         WHERE c.x = f.x AND c.y = f.y AND c.status = 'open' AND c.expires_at > ?
       )`,
      [at],
    );
    return rows.map((r) => coords.coord(r.x, r.y)).sort(coords.compare);
  }

  /** Open slots that no live claim is sitting on. */
  async frontier(): Promise<Coordinate[]> {
    const at = now();
    await this.#reap(at);
    return this.#availableSlots(at);
  }

  /** Seconds until a world-wide budget has room again, or 0 if it does now. */
  async #rateWait(kind: RateKind, perHour: number, at: number): Promise<number> {
    if (perHour <= 0) {
      return 0;
    }
    const cutoff = at - CLAIM_RATE_WINDOW_SECONDS;
    await this.#db.run("DELETE FROM rate_grants WHERE kind = ? AND granted_at <= ?", [kind, cutoff]);
    const row = await this.#db.first<{ c: number; oldest: number | null }>(
      "SELECT COUNT(*) AS c, MIN(granted_at) AS oldest FROM rate_grants WHERE kind = ?",
      [kind],
    );
    const count = row?.c ?? 0;
    if (count < perHour) {
      return 0;
    }
    return (row!.oldest as number) + CLAIM_RATE_WINDOW_SECONDS - at;
  }

  /**
   * Spend one slot of a world-wide budget, or throw `RateLimited`. The
   * count check and the insert happen in one conditional SQL statement.
   * Not used by `allocate()`, which guards its claim rate inside its own
   * batch instead.
   */
  async #spend(kind: RateKind, perHour: number): Promise<void> {
    if (perHour <= 0) {
      return;
    }
    const at = now();
    // Remove grants outside the rate window.
    await this.#db.run("DELETE FROM rate_grants WHERE kind = ? AND granted_at <= ?", [
      kind,
      at - CLAIM_RATE_WINDOW_SECONDS,
    ]);
    const result = await this.#db.run(
      "INSERT INTO rate_grants (kind, granted_at) SELECT ?, ? WHERE " +
        "(SELECT COUNT(*) FROM rate_grants WHERE kind = ? AND granted_at > ?) < ?",
      [kind, at, kind, at - CLAIM_RATE_WINDOW_SECONDS, perHour],
    );
    if (result.changes === 0) {
      throw new RateLimited(kind, await this.#rateWait(kind, perHour, now()), perHour);
    }
  }

  /** Spends one registration slot from the world-wide budget. */
  registrationSlot(): Promise<void> {
    return this.#spend(RateKind.REGISTRATION, this.#registrationsPerHour);
  }

  async getClaim(claimId: string): Promise<Claim | null> {
    await this.#reap(now());
    const row = await this.#db.first<ClaimRow>("SELECT * FROM claims WHERE claim_id = ?", [
      claimId,
    ]);
    return row === null ? null : rowToClaim(row);
  }

  /**
   * Hand this agent one coordinate off the frontier, chosen uniformly at
   * random from the open slots. Checks, in order: the agent's cooldown, an
   * existing open claim for this agent, and the world-wide claim rate. The
   * coordinate insert and the rate-limit grant are one conditional
   * statement; if it fails (`changes === 0`), retries against a fresh
   * candidate list, up to `MAX_ALLOCATE_ATTEMPTS` times.
   */
  async allocate(agent: Agent): Promise<Claim> {
    await this.#reap(now());

    const remaining = cooldownRemaining(agent);
    if (remaining > 0) {
      throw new NotYet(`${remaining.toFixed(1)}s left before your next sector`);
    }

    const existing = await this.activeClaimFor(agent.agentId);
    if (existing !== null) {
      throw new SectorUnavailable(
        "claim_in_progress",
        `you already hold claim ${existing.claimId}; submit it or release it before ` +
          "claiming again",
      );
    }

    let wait = await this.#rateWait(RateKind.CLAIM, this.#claimsPerHour, now());
    if (wait > 0) {
      throw new RateLimited(RateKind.CLAIM, wait, this.#claimsPerHour);
    }

    for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt += 1) {
      const at = now();
      const candidates = await this.#availableSlots(at);
      if (candidates.length === 0) {
        throw new SectorUnavailable(
          "frontier_busy",
          "every open coordinate is currently leased to another agent; retry shortly",
        );
      }

      const coordinate = candidates[Math.floor(Math.random() * candidates.length)]!;
      const claimId = `claim_${randomHex(8)}`;
      const theme = drawTheme();
      const expiresAt = at + this.#leaseSeconds;
      const rateGuard =
        this.#claimsPerHour > 0
          ? " AND (SELECT COUNT(*) FROM rate_grants WHERE kind = 'claim' AND granted_at > ?) < ?"
          : "";
      const rateParams =
        this.#claimsPerHour > 0 ? [at - CLAIM_RATE_WINDOW_SECONDS, this.#claimsPerHour] : [];

      const statements: Statement[] = [
        {
          sql:
            "INSERT INTO claims (claim_id, agent_id, x, y, status, created_at, expires_at, attempts, genre, size, mood) " +
            "SELECT ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ? " +
            "WHERE NOT EXISTS (" +
            "  SELECT 1 FROM claims WHERE x = ? AND y = ? AND status = 'open' AND expires_at > ?" +
            ") AND NOT EXISTS (" +
            // Refuses the insert if this agent already has an open claim.
            "  SELECT 1 FROM claims WHERE agent_id = ? AND status = 'open' AND expires_at > ?" +
            `)${rateGuard}`,
          params: [
            claimId,
            agent.agentId,
            coordinate.x,
            coordinate.y,
            at,
            expiresAt,
            theme.genre,
            theme.size,
            theme.mood,
            coordinate.x,
            coordinate.y,
            at,
            agent.agentId,
            at,
            ...rateParams,
          ],
        },
      ];
      if (this.#claimsPerHour > 0) {
        statements.push({
          sql:
            "INSERT INTO rate_grants (kind, granted_at) SELECT 'claim', ? " +
            "WHERE EXISTS (SELECT 1 FROM claims WHERE claim_id = ?)",
          params: [at, claimId],
        });
      }

      const results = await this.#db.batch(statements);
      if (results[0]!.changes === 1) {
        return {
          claimId,
          agentId: agent.agentId,
          coordinate,
          expiresAt,
          createdAt: at,
          status: ClaimStatus.OPEN,
          attempts: 0,
          imageKey: null,
          theme,
          draft: null,
        };
      }

      // The insert did not take. Check whether this agent now holds a claim,
      // or the rate limit is full, before retrying with a fresh candidate list.
      const raced = await this.activeClaimFor(agent.agentId);
      if (raced !== null) {
        throw new SectorUnavailable(
          "claim_in_progress",
          `you already hold claim ${raced.claimId}; submit it or release it before ` +
            "claiming again",
        );
      }
      wait = await this.#rateWait(RateKind.CLAIM, this.#claimsPerHour, now());
      if (wait > 0) {
        throw new RateLimited(RateKind.CLAIM, wait, this.#claimsPerHour);
      }
    }
    throw new SectorUnavailable(
      "frontier_busy",
      "every open coordinate is currently leased to another agent; retry shortly",
    );
  }

  /** This agent's live claim, or null. An agent holds at most one open claim at a time. */
  async activeClaimFor(agentId: string, at: number = now()): Promise<Claim | null> {
    const row = await this.#db.first<ClaimRow>(
      "SELECT * FROM claims WHERE agent_id = ? AND status = 'open' AND expires_at > ? LIMIT 1",
      [agentId, at],
    );
    return row === null ? null : rowToClaim(row);
  }

  /**
   * Throws unless this agent may upload an image right now, and returns the
   * claim it would count against.
   */
  async checkCanUploadImage(agent: Agent): Promise<Claim> {
    const claim = await this.activeClaimFor(agent.agentId);
    if (claim === null) {
      throw new UploadRefused(
        "claim_required",
        "an image belongs to a sector you are in the middle of writing: claim one " +
          "with POST /v1/claims first, then upload, then pass the url in that claim's " +
          "own submission",
      );
    }
    if (claim.imageKey !== null) {
      throw new UploadRefused(
        "image_already_uploaded",
        `claim ${claim.claimId} has already used its one image; pass the url you were ` +
          "given, or release the claim if you meant to start over",
      );
    }
    return claim;
  }

  /**
   * Sets this claim's image key to `key`, if the claim is still open,
   * unexpired, and has no image key yet. Returns false if not.
   */
  async takeClaimImage(claim: Claim, key: string): Promise<boolean> {
    const result = await this.#db.run(
      "UPDATE claims SET image_key = ? WHERE claim_id = ? AND status = 'open' " +
        "AND expires_at > ? AND image_key IS NULL",
      [key, claim.claimId, now()],
    );
    if (result.changes === 0) {
      return false;
    }
    claim.imageKey = key;
    return true;
  }

  /**
   * Images whose claim is no longer open and whose key is not referenced by
   * any sector, oldest first. Reaps expired claims first.
   */
  async reapableImages(limit: number): Promise<{ claimId: string; key: string }[]> {
    await this.#reap(now());
    const rows = await this.#db.all<{ claim_id: string; image_key: string }>(
      `SELECT c.claim_id, c.image_key FROM claims c
       WHERE c.image_key IS NOT NULL
         AND c.status != 'open'
         AND NOT EXISTS (
           SELECT 1 FROM sectors s WHERE s.image = '/v1/images/' || c.image_key
         )
       ORDER BY c.created_at
       LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({ claimId: r.claim_id, key: r.image_key }));
  }

  /** Clears the image key on each given claim, in one statement. */
  async clearClaimImages(claimIds: readonly string[]): Promise<void> {
    if (claimIds.length === 0) {
      return;
    }
    const holes = claimIds.map(() => "?").join(", ");
    await this.#db.run(
      `UPDATE claims SET image_key = NULL WHERE claim_id IN (${holes})`,
      [...claimIds],
    );
  }

  /** Give the sector back. The agent keeps its token and may claim again. */
  async release(claim: Claim): Promise<void> {
    if (claim.status === ClaimStatus.OPEN) {
      claim.status = ClaimStatus.RELEASED;
      await this.#db.run("UPDATE claims SET status = 'released' WHERE claim_id = ? AND status = 'open'", [
        claim.claimId,
      ]);
    }
  }

  /**
   * Saves this submission as the claim's current draft. Never touches
   * attempts, status, or the world. The draft carries no lease of its own —
   * it lapses when the claim itself does.
   */
  async saveDraft(claim: Claim, raw: unknown): Promise<void> {
    await this.#db.run("UPDATE claims SET draft = ? WHERE claim_id = ? AND status = 'open'", [
      JSON.stringify(raw),
      claim.claimId,
    ]);
    claim.draft = raw;
  }

  async noteAttempt(claim: Claim): Promise<void> {
    claim.attempts += 1;
    await this.#db.run("UPDATE claims SET attempts = ? WHERE claim_id = ?", [
      claim.attempts,
      claim.claimId,
    ]);
  }

  // --- the contribution clock ---------------------------------------------

  /** Marks the claim baked, adds the coordinate to the agent's sectors, and restarts the cooldown. */
  async settle(agent: Agent, claim: Claim): Promise<void> {
    claim.status = ClaimStatus.BAKED;
    await this.#db.run("UPDATE claims SET status = 'baked' WHERE claim_id = ?", [claim.claimId]);
    agent.coordinates.push(claim.coordinate);
    agent.nextContributionAt = now() + this.#cooldownSeconds;
    await this.#persist(agent);
  }

  /** Throws unless this agent may place an object (or an interaction) right now. */
  checkCanContribute(agent: Agent): void {
    if (!isSettled(agent)) {
      throw new SectorRequired("author a sector before you can furnish one");
    }
  }

  /** Increments the agent's object count. Does not touch the cooldown. */
  async noteContribution(agent: Agent): Promise<void> {
    agent.objectsCreated += 1;
    await this.#persist(agent);
  }

  async stats(): Promise<Record<string, number>> {
    await this.#reap(now());
    const [agentTotals, claimCounts] = await Promise.all([
      this.#db.first<{ total: number; settled: number; sectors_owned: number }>(
        "SELECT COUNT(*) AS total, " +
          "SUM(CASE WHEN json_array_length(coordinates) > 0 THEN 1 ELSE 0 END) AS settled, " +
          "COALESCE(SUM(json_array_length(coordinates)), 0) AS sectors_owned " +
          "FROM agents",
      ),
      this.#db.all<{ status: ClaimStatus; c: number }>(
        "SELECT status, COUNT(*) AS c FROM claims GROUP BY status",
      ),
    ]);
    const counted = (status: ClaimStatus) =>
      claimCounts.find((row) => row.status === status)?.c ?? 0;
    return {
      agents: agentTotals?.total ?? 0,
      agents_settled: agentTotals?.settled ?? 0,
      sectors_owned: agentTotals?.sectors_owned ?? 0,
      claims_open: counted(ClaimStatus.OPEN),
      claims_baked: counted(ClaimStatus.BAKED),
      claims_expired: counted(ClaimStatus.EXPIRED),
      claims_released: counted(ClaimStatus.RELEASED),
    };
  }
}
