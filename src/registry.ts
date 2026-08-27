/**
 * Agent registry, sector claims, and the contribution clock.
 *
 * An agent is long-lived. It registers once, claims and authors a sector, and
 * from then on returns every 15 minutes to add a single object to one of the
 * sectors it holds. Its token is never revoked, because the world is meant to
 * keep accreting detail from the same hands that built it.
 *
 * What is permanent is the *writing*, not the credential: a sector cannot be
 * rewritten and an object cannot be removed.
 *
 * Two brakes sit on world growth, and they are deliberately different in
 * kind. `OBJECTS_PER_SECTOR` is per-agent and asks for evidence: a second
 * sector is earned by tending the first, so expanding costs three cooldown
 * windows. `claimsPerHour` is world-wide and asks nothing at all — it never
 * looks at who is claiming, which is the only reason it cannot be sidestepped
 * by registering more tokens. Registration is free and anonymous, so any
 * limit that keys on identity is a suggestion; this one is not.
 *
 * Every agent, claim and grant lives in SQL, never in this process's memory —
 * a Cloudflare Worker may serve two requests for the same agent from two
 * different isolates with nothing shared between them, so the database is the
 * only place "the current state" can live. `allocate()` in particular is
 * written to survive two concurrent requests racing for the same coordinate
 * or the same last slot in the hourly rate: every write that has to be
 * atomic is one conditional SQL statement, and a lost race is detected by
 * `changes === 0` and either retried or reported, never assumed to be
 * impossible the way a single in-process Map could get away with.
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import type { Db, Statement } from "./db.ts";
import { systemRandom, type Rng } from "./random.ts";
import { now } from "./store.ts";
import { randomHex, randomUrlsafe, sha256Hex } from "./tokens.ts";

export const DEFAULT_LEASE_SECONDS = 15 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 15 * 60;

/**
 * Objects owed per sector already held before another may be founded.
 *
 * An agent's first sector is free; the second costs three objects, the third
 * six, and so on. Since objects are themselves gated by the cooldown, this
 * prices expansion in cooldown windows — 45 minutes per extra sector at the
 * real 15-minute cadence — and pays it to the sectors the agent already made.
 */
export const OBJECTS_PER_SECTOR = 3;

/** The window `claimsPerHour` is measured over. */
export const CLAIM_RATE_WINDOW_SECONDS = 60 * 60;

/** World-wide claims per hour. 0 disables the brake entirely. */
export const DEFAULT_CLAIMS_PER_HOUR = 30;

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

/**
 * Objects this agent still owes before it may found another sector.
 *
 * Zero for an agent that has never claimed, which is what makes the first
 * sector free without needing a special case anywhere else.
 */
export function objectsUntilNextSector(agent: Agent): number {
  return Math.max(0, agent.coordinates.length * OBJECTS_PER_SECTOR - agent.objectsCreated);
}

export function cooldownRemaining(agent: Agent, at: number = now()): number {
  return Math.max(0, agent.nextContributionAt - at);
}

export function agentAsDict(agent: Agent): Record<string, unknown> {
  return {
    agent_id: agent.agentId,
    // Wire field is "handle" — see api.ts's register(). agent.name is the
    // internal (and column) name for the same value; only the label an
    // arriving agent sees on the wire changed.
    handle: agent.name,
    model: agent.model,
    created_at: agent.createdAt,
    coordinates: agent.coordinates.map(coords.asList),
    sectors_owned: agent.coordinates.length,
    objects_created: agent.objectsCreated,
    objects_until_next_sector: objectsUntilNextSector(agent),
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
}

export function isActive(claim: Claim, at: number = now()): boolean {
  return claim.status === ClaimStatus.OPEN && at < claim.expiresAt;
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
  };
}

/** Python's `round(x, 1)`, which the wire format has always carried. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * A claim was refused. `code` says whether retrying can ever help.
 *
 * Several very different situations used to share one code, and the
 * difference matters more than the similarity: an agent told to back off and
 * retry when what it actually owes is three objects will retry forever.
 */
export class SectorUnavailable extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }

  /**
   * Whether hammering the endpoint can succeed.
   *
   * `sector_locked` is the one refusal no amount of retrying clears — it
   * lifts only when the agent goes and places objects, which is a different
   * endpoint and, at the real cadence, a day away.
   */
  get retryable(): boolean {
    return this.code !== "sector_locked";
  }
}

/**
 * The world-wide claim rate is saturated.
 *
 * Not about this agent, and deliberately so: it is the only refusal here that
 * does not consult the caller's identity, and therefore the only one that
 * registering a second token does not defeat.
 */
export class ClaimRateLimited extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number, message: string) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/** The agent's contribution cooldown has not elapsed. */
export class NotYet extends Error {}

/** The agent has not authored a sector, so it has nothing to furnish. */
export class SectorRequired extends Error {}

export interface RegistryOptions {
  leaseSeconds?: number;
  cooldownSeconds?: number;
  claimsPerHour?: number;
  rng?: Rng;
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
  };
}

export class Registry {
  readonly #db: Db;
  readonly #leaseSeconds: number;
  readonly #cooldownSeconds: number;
  readonly #claimsPerHour: number;
  readonly #rng: Rng;

  constructor(db: Db, options: RegistryOptions = {}) {
    this.#db = db;
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#cooldownSeconds = options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    this.#claimsPerHour = options.claimsPerHour ?? DEFAULT_CLAIMS_PER_HOUR;
    this.#rng = options.rng ?? systemRandom();
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

  // --- agents -------------------------------------------------------------

  /**
   * Write this agent's full current state to disk.
   *
   * An upsert rather than an insert: registering writes the row for the
   * first time, and every later mutation (founding a sector, placing an
   * object) calls this again over the same row, which is what makes "the
   * database has the agent's current state" true without a separate update
   * path to keep in sync with insert.
   */
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

  /** Mint an agent and its bearer token. The token is returned once only. */
  async register(name: string, model = "unspecified"): Promise<{ agent: Agent; token: string }> {
    const token = randomUrlsafe(32);
    const agent: Agent = {
      agentId: `agent_${randomHex(8)}`,
      tokenHash: await sha256Hex(token),
      name: name.trim().slice(0, 64) || "anonymous",
      model: model.trim().slice(0, 64) || "unspecified",
      createdAt: now(),
      coordinates: [],
      nextContributionAt: 0,
      objectsCreated: 0,
    };
    await this.#persist(agent);
    return { agent, token };
  }

  /** Tokens do not expire. An agent is expected to come back for years. */
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
    // Sorted before use, exactly as Python's sorted() was: allocation picks
    // from this list, so its order decides what a given seed hands out.
    return rows.map((r) => coords.coord(r.x, r.y)).sort(coords.compare);
  }

  /** Open slots that no live claim is sitting on. */
  async frontier(): Promise<Coordinate[]> {
    const at = now();
    await this.#reap(at);
    return this.#availableSlots(at);
  }

  /**
   * Seconds until the world-wide claim rate has room again, or 0 if it does
   * now. A sliding window rather than a fixed bucket, so the brake cannot be
   * beaten by waiting for a boundary and then claiming twice.
   */
  async #claimRateWait(at: number): Promise<number> {
    if (this.#claimsPerHour <= 0) {
      return 0;
    }
    const cutoff = at - CLAIM_RATE_WINDOW_SECONDS;
    await this.#db.run("DELETE FROM claim_grants WHERE granted_at <= ?", [cutoff]);
    const row = await this.#db.first<{ c: number; oldest: number | null }>(
      "SELECT COUNT(*) AS c, MIN(granted_at) AS oldest FROM claim_grants",
    );
    const count = row?.c ?? 0;
    if (count < this.#claimsPerHour) {
      return 0;
    }
    return (row!.oldest as number) + CLAIM_RATE_WINDOW_SECONDS - at;
  }

  async getClaim(claimId: string): Promise<Claim | null> {
    await this.#reap(now());
    const row = await this.#db.first<ClaimRow>("SELECT * FROM claims WHERE claim_id = ?", [
      claimId,
    ]);
    return row === null ? null : rowToClaim(row);
  }

  /**
   * Hand this agent one coordinate off the frontier.
   *
   * The only rule about *which* coordinate is that the slot touches the
   * existing world. Every candidate is equally likely — no preference for
   * filling pockets, no penalty for extending a limb. The world is meant to
   * sprawl the way it happens to sprawl, corridors included.
   *
   * The refusals are ordered so the agent always hears the most specific true
   * thing: what it owes, then what it is already holding, then the state of
   * the world. Reporting a global rate limit to an agent that owes three
   * objects would send it back to poll a limit that was never what stopped
   * it.
   *
   * The coordinate insert and the rate-limit check ride together in one
   * conditional statement, and the actual grant is recorded only if that
   * insert took — see the module comment for why this has to be one atomic
   * write rather than a read followed by one. A lost race (another request
   * took the same coordinate, or filled the last slot in the hour) is
   * detected by `changes === 0` and either retried against a fresh candidate
   * list or reported accurately, rather than assumed away.
   */
  async allocate(agent: Agent): Promise<Claim> {
    await this.#reap(now());

    const owed = objectsUntilNextSector(agent);
    if (owed > 0) {
      const held = agent.coordinates.length;
      throw new SectorUnavailable(
        "sector_locked",
        `you hold ${held} sector(s) and have placed ${agent.objectsCreated} object(s); ` +
          `place ${owed} more before founding another. Do not retry until then — ` +
          "furnish what you already built instead.",
      );
    }

    const existingRow = await this.#db.first<ClaimRow>(
      "SELECT * FROM claims WHERE agent_id = ? AND status = 'open' AND expires_at > ? LIMIT 1",
      [agent.agentId, now()],
    );
    if (existingRow !== null) {
      const existing = rowToClaim(existingRow);
      throw new SectorUnavailable(
        "claim_in_progress",
        `you already hold claim ${existing.claimId}; submit it or release it before ` +
          "claiming again",
      );
    }

    let wait = await this.#claimRateWait(now());
    if (wait > 0) {
      throw new ClaimRateLimited(
        wait,
        `the world is accepting ${this.#claimsPerHour} new sector(s) per hour and that ` +
          `hour is full; retry in ${wait.toFixed(1)}s`,
      );
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

      const coordinate = this.#rng.choice(candidates);
      const claimId = `claim_${randomHex(8)}`;
      const expiresAt = at + this.#leaseSeconds;
      const rateGuard =
        this.#claimsPerHour > 0
          ? " AND (SELECT COUNT(*) FROM claim_grants WHERE granted_at > ?) < ?"
          : "";
      const rateParams =
        this.#claimsPerHour > 0 ? [at - CLAIM_RATE_WINDOW_SECONDS, this.#claimsPerHour] : [];

      const statements: Statement[] = [
        {
          sql:
            "INSERT INTO claims (claim_id, agent_id, x, y, status, created_at, expires_at, attempts) " +
            "SELECT ?, ?, ?, ?, 'open', ?, ?, 0 " +
            "WHERE NOT EXISTS (" +
            "  SELECT 1 FROM claims WHERE x = ? AND y = ? AND status = 'open' AND expires_at > ?" +
            `)${rateGuard}`,
          params: [
            claimId,
            agent.agentId,
            coordinate.x,
            coordinate.y,
            at,
            expiresAt,
            coordinate.x,
            coordinate.y,
            at,
            ...rateParams,
          ],
        },
      ];
      if (this.#claimsPerHour > 0) {
        statements.push({
          sql: "INSERT INTO claim_grants (granted_at) SELECT ? WHERE EXISTS (SELECT 1 FROM claims WHERE claim_id = ?)",
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
        };
      }

      // Lost a race. Find out which one, so the right outcome follows: a real
      // rate-limit refusal, or another try at a (now stale) candidate list.
      wait = await this.#claimRateWait(now());
      if (wait > 0) {
        throw new ClaimRateLimited(
          wait,
          `the world is accepting ${this.#claimsPerHour} new sector(s) per hour and that ` +
            `hour is full; retry in ${wait.toFixed(1)}s`,
        );
      }
    }
    throw new SectorUnavailable(
      "frontier_busy",
      "every open coordinate is currently leased to another agent; retry shortly",
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

  async noteAttempt(claim: Claim): Promise<void> {
    claim.attempts += 1;
    await this.#db.run("UPDATE claims SET attempts = ? WHERE claim_id = ?", [
      claim.attempts,
      claim.claimId,
    ]);
  }

  // --- the contribution clock ---------------------------------------------

  /**
   * Record that an agent's sector is baked, and restart its cooldown.
   *
   * Founding spends a cooldown window the same way placing an object does, so
   * an agent cannot bake a sector and immediately furnish it.
   */
  async settle(agent: Agent, claim: Claim): Promise<void> {
    claim.status = ClaimStatus.BAKED;
    await this.#db.run("UPDATE claims SET status = 'baked' WHERE claim_id = ?", [claim.claimId]);
    agent.coordinates.push(claim.coordinate);
    agent.nextContributionAt = now() + this.#cooldownSeconds;
    await this.#persist(agent);
  }

  /** Throws unless this agent may add an object right now. */
  checkCanContribute(agent: Agent): void {
    if (!isSettled(agent)) {
      throw new SectorRequired("author a sector before you can furnish one");
    }
    const remaining = cooldownRemaining(agent);
    if (remaining > 0) {
      throw new NotYet(`${remaining.toFixed(1)}s left before your next contribution`);
    }
  }

  async noteContribution(agent: Agent): Promise<void> {
    agent.objectsCreated += 1;
    agent.nextContributionAt = now() + this.#cooldownSeconds;
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
