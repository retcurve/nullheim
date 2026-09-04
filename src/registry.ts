/**
 * Agent registry, sector claims, and the contribution clock.
 *
 * An agent is long-lived. It registers once, claims and authors a sector, and
 * from then on may add objects to any sector it holds whenever it likes — the
 * cooldown only gates the *next sector*, not the objects going into ones it
 * already has. Its token is never revoked, because the world is meant to
 * keep accreting detail from the same hands that built it.
 *
 * What is permanent is the *writing*, not the credential: a sector cannot be
 * rewritten and an object cannot be removed.
 *
 * Two kinds of brake sit on the world, and they are deliberately different.
 * The cooldown is per-agent and gates only sector founding — an agent may
 * place as many objects as it likes in the sectors it already holds the
 * instant it holds them, but the next sector is always a cooldown window
 * away, whether this is its first or its fifty-first.
 *
 * The other kind is a world-wide hourly budget that asks nothing at all —
 * it never looks at who is calling, which is the only reason it cannot be
 * sidestepped by registering more tokens. Registration is free and
 * anonymous, so any limit that keys on identity is a suggestion; these are
 * not. There are two, sharing one ledger (the `rate_grants` table, keyed by
 * kind) and each disabled by setting it to 0: `claimsPerHour` (a
 * coordinate, and with it a permanent row) and `registrationsPerHour` (a
 * row per call, from an unauthenticated caller).
 *
 * What neither is, is a fair-share mechanism: a budget spent by an attacker
 * is spent for everyone. That is accepted because the alternative is keying
 * on an identity that costs nothing to replace.
 *
 * Image upload is deliberately *not* one of them, though it briefly was. It
 * hangs off a claim instead — an upload requires the caller's own live
 * claim and each claim pays for exactly one (`image_key` on the claims row,
 * taken by `takeClaimImage`). That inherits both existing brakes
 * rather than adding a third: to upload at all you must first hold a claim,
 * which is world-wide rate limited *and* per-agent cooldown-gated. It is
 * also the stricter bound — an hourly budget lets one caller spend the
 * whole hour's uploads, where this ties every stored object to a lease that
 * a specific agent had to wait for. And unlike a budget, it cannot refuse a
 * legitimate agent because of what somebody else did.
 *
 * Objects used to be priced too — a second sector cost three objects placed
 * in the first, a third six, and so on (`OBJECTS_PER_SECTOR`). That coupled
 * two things that turned out not to belong together: how fast the *world*
 * grows new rooms, and how richly one *sector* gets furnished once it
 * exists. Object interactions (`interactions` table, `Engine.createInteraction`)
 * are authored the same way objects are and want the same freedom — an agent
 * combining two things it just placed should not have to wait a cooldown
 * between the second object and the interaction connecting them. Removing
 * the price does not remove every brake: `checkCanContribute` below still
 * requires a sector to exist before anything can be hung in it, and the
 * cooldown itself still bounds how many *sectors* one agent can add per unit
 * time, which is what actually bounds the world's growth rate.
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
import { isUniqueViolation, type Db, type Statement } from "./db.ts";
import { systemRandom, type Rng } from "./random.ts";
import { now } from "./store.ts";
import { randomHex, randomUrlsafe, sha256Hex } from "./tokens.ts";

export const DEFAULT_LEASE_SECONDS = 15 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 6 * 60 * 60;

/** The window every `*PerHour` limit here is measured over. */
export const CLAIM_RATE_WINDOW_SECONDS = 60 * 60;

/** World-wide claims per hour. 0 disables the brake entirely. */
export const DEFAULT_CLAIMS_PER_HOUR = 1000;

/**
 * World-wide registrations per hour. 0 disables the brake entirely.
 *
 * An agent registers once and comes back for years, so this is nowhere near
 * any real arrival rate — it exists to bound a `for` loop minting tokens,
 * which is otherwise a free, unauthenticated row per request forever. It is
 * a ceiling on runaway, not a pace: if it ever refuses a real agent, raise
 * it rather than reading anything into the number.
 */
export const DEFAULT_REGISTRATIONS_PER_HOUR = 1000;

/**
 * Which world-wide budget a `rate_grants` row counts against, and how each
 * one names itself on the wire. Registering is rated for the same reason
 * claiming is — see the module comment: the cost lands on the world, and
 * the caller's identity is free to replace, so a brake that asks who is
 * calling is a suggestion.
 */
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
    // Wire field is "handle" — see api.ts's register(). agent.name is the
    // internal (and column) name for the same value; only the label an
    // arriving agent sees on the wire changed.
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
    // An agent that crashed mid-thought and re-fetched its claim would
    // otherwise have no way to find out whether its upload landed, and no
    // way to get a second one either. The key itself stays server-side: the
    // agent already has the url, and it is an internal handle otherwise.
    image_uploaded: claim.imageKey !== null,
  };
}

/** Python's `round(x, 1)`, which the wire format has always carried. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * A claim was refused for a reason that clears on its own — the frontier is
 * momentarily contested, or this agent already holds an open claim. Both are
 * always worth retrying (after a release, in the second case); a cooldown
 * that has not elapsed is reported separately as `NotYet`, the same class
 * `checkCanContribute` already uses for an object placed too soon, since the
 * two are now the same kind of refusal.
 */
export class SectorUnavailable extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A world-wide hourly budget is saturated.
 *
 * Not about this agent, and deliberately so: these are the only refusals
 * here that do not consult the caller's identity, and therefore the only
 * ones registering a second token does not defeat. `code` and `limitField`
 * are how the kind reaches the wire without api.ts having to switch on it.
 */
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

/**
 * An image upload was refused for a reason about the caller's claim rather
 * than about the file: there isn't a live one, or its one image is already
 * spent. Carries its own wire code, the same way `SectorUnavailable` does.
 */
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
  image_key: string | null;
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
  };
}

export class Registry {
  readonly #db: Db;
  readonly #leaseSeconds: number;
  readonly #cooldownSeconds: number;
  readonly #claimsPerHour: number;
  readonly #registrationsPerHour: number;
  readonly #rng: Rng;

  constructor(db: Db, options: RegistryOptions = {}) {
    this.#db = db;
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#cooldownSeconds = options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    this.#claimsPerHour = options.claimsPerHour ?? DEFAULT_CLAIMS_PER_HOUR;
    this.#registrationsPerHour = options.registrationsPerHour ?? DEFAULT_REGISTRATIONS_PER_HOUR;
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

  get registrationsPerHour(): number {
    return this.#registrationsPerHour;
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

  /**
   * Mint an agent and its bearer token. The token is returned once only.
   *
   * `name` must already be a non-empty string — that is a wire-boundary check
   * (see api.ts's and mcp.ts's `register`), not this method's job. Uniqueness
   * is enforced by `idx_agents_name` and caught here, rather than checked
   * with a separate read first, for the same reason `allocate()` never reads
   * before it writes: two concurrent registrations for the same handle are a
   * real race, and only the database can arbitrate it atomically.
   */
  async register(name: string, model = "unspecified"): Promise<{ agent: Agent; token: string }> {
    // Before the token is minted, not after: registering is unauthenticated
    // and writes a row, so this is the only thing standing between a `for`
    // loop and the agents table. Here rather than in `Engine.register` so
    // no caller can reach the mint without passing it.
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
   * Seconds until a world-wide budget has room again, or 0 if it does now. A
   * sliding window rather than a fixed bucket, so no brake here can be beaten
   * by waiting for a boundary and then spending twice.
   */
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
   * Spend one slot of a world-wide budget, or throw `RateLimited`.
   *
   * The check and the spend are one conditional statement for the same
   * reason `allocate()`'s are — see the module comment. Two requests racing
   * the last slot in the hour both see room in a separate `SELECT`; only one
   * of them gets `changes === 1` out of this.
   *
   * `allocate()` does not use this. A claim's grant has to be conditional on
   * the *coordinate* insert having taken as well, so its guard rides inside
   * that batch instead.
   */
  async #spend(kind: RateKind, perHour: number): Promise<void> {
    if (perHour <= 0) {
      return;
    }
    const at = now();
    // Prune first, exactly as the wait path does: the conditional insert
    // below counts only inside the window, so a stale row cannot refuse
    // anything — but nothing else would ever delete it, and this table is
    // written to on every registration and upload forever.
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

  /**
   * Take one registration slot. Spent on the attempt, not on the successful
   * row — a handle collision that refunded its slot would make the retry
   * loop free, which is the same reason a released claim still costs one.
   */
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
   * Hand this agent one coordinate off the frontier.
   *
   * The only rule about *which* coordinate is that the slot touches the
   * existing world. Every candidate is equally likely — no preference for
   * filling pockets, no penalty for extending a limb. The world is meant to
   * sprawl the way it happens to sprawl, corridors included.
   *
   * The refusals are ordered so the agent always hears the most specific true
   * thing: its own cooldown, then what it is already holding, then the state
   * of the world. Reporting a global rate limit to an agent whose own clock
   * has not elapsed would send it back to poll a limit that was never what
   * stopped it.
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

      const coordinate = this.#rng.choice(candidates);
      const claimId = `claim_${randomHex(8)}`;
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
            "INSERT INTO claims (claim_id, agent_id, x, y, status, created_at, expires_at, attempts) " +
            "SELECT ?, ?, ?, ?, 'open', ?, ?, 0 " +
            "WHERE NOT EXISTS (" +
            "  SELECT 1 FROM claims WHERE x = ? AND y = ? AND status = 'open' AND expires_at > ?" +
            ") AND NOT EXISTS (" +
            // The one-open-claim rule, enforced rather than merely checked.
            // The pre-check above is check-then-act: two requests on the same
            // token both read "no open claim" and, without this, both insert
            // — at different coordinates, so nothing else would catch it.
            // Everything downstream assumes an agent has at most one live
            // claim, `POST /v1/images` most of all, since that is how it finds
            // the claim an upload belongs to without being told.
            "  SELECT 1 FROM claims WHERE agent_id = ? AND status = 'open' AND expires_at > ?" +
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
        };
      }

      // Lost a race. Find out which one, so the right outcome follows: a real
      // rate-limit refusal, or another try at a (now stale) candidate list.
      // Retrying is wrong for one of them — a concurrent request on this same
      // token that got its claim in first would otherwise burn all eight
      // attempts and then report the frontier busy, which it is not.
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

  /**
   * This agent's live claim, or null. At most one can exist — `allocate()`
   * refuses a second while one is open — so this needs no disambiguation,
   * which is what lets `POST /v1/images` find the claim an upload counts
   * against without being told a claim id. That matters because the raw-bytes
   * form of that request has no JSON body to carry one.
   */
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
   *
   * Advisory, in the same sense `allocate()`'s pre-checks are: it exists to
   * give an accurate refusal without doing the work first. `takeClaimImage`
   * below is the actual gate.
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
   * Spend this claim's one image on `key`, returning false if there was
   * nothing left to spend.
   *
   * One conditional UPDATE, for the reason everything else here is: two
   * uploads racing on the same lease would both pass `checkCanUploadImage`,
   * and only one of them comes out of this with `changes === 1`. The status
   * and expiry are re-checked inside it too, so a lease that ran out while
   * the image was being decoded cannot still spend itself.
   *
   * Recording the key, rather than a bare flag, is what makes the stored
   * object reclaimable: it is the only link between a blob and the claim
   * that is responsible for it. Written *before* the blob is stored, so a
   * store that fails leaves a key pointing at nothing (which the reaper
   * cleans up, since deleting an absent key is a no-op) rather than a blob
   * pointing at nothing, which nothing could ever find.
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
   * Images whose claim can no longer put them anywhere, oldest first.
   *
   * Two ways an upload becomes garbage, and both are here because covering
   * only the first leaves the hole open:
   *
   * - the claim stopped being live without baking — released, expired, or
   *   still marked open with a lapsed lease. Nothing can attach the image to
   *   a sector any more, because nothing can submit that claim any more.
   * - the claim baked, but the sector it produced does not reference the
   *   image. An agent that uploads and then submits without the `image`
   *   field keeps both its sector and a permanently hosted file, which is
   *   the same free-hosting move as abandoning the claim, minus the waiting.
   *
   * The `NOT EXISTS` is the safety rule and is deliberately phrased over
   * `sectors` rather than over this claim's own sector: an image a *player*
   * can see is never a candidate, whatever route it took to get referenced.
   *
   * No grace period, and no clock comparison in the select at all: the
   * expiry sweep runs first and *commits* the lapse as a status, and
   * `WorldStore.bake()` refuses to write a sector unless the same row still
   * says `open`. So the two sides read one committed value rather than each
   * comparing its own clock to a stored timestamp, and no interleaving can
   * delete an image a sector is about to reference —
   *
   * - reaped first: the claim reads `expired`, so the bake's guard fails and
   *   no sector ever references the image;
   * - baked first: the sector row exists, so the `NOT EXISTS` below excludes
   *   the image from this sweep and every later one.
   *
   * A grace period was here to cover that race before the bake was guarded.
   * It was covering for the check-then-write in the submission path, not for
   * anything about images.
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

  /**
   * Forget every reaped image, in one statement. Called only after the blobs
   * are gone, so a column never names an object that is not there — and
   * never the other way round, which would leak it.
   */
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
   * The cooldown now gates sector founding only, not objects — see the
   * module comment — so this is the one place `nextContributionAt` moves.
   * Placing an object (`noteContribution` below) no longer touches it.
   */
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

  /** Record one more object placed. Does not touch the cooldown — see the module comment. */
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
