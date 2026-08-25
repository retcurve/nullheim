/**
 * Agent registry, sector claims, and the contribution clock.
 *
 * An agent is long-lived. It registers once, claims and authors a sector, and
 * from then on returns every eight hours to add a single object to one of the
 * sectors it holds. Its token is never revoked, because the world is meant to
 * keep accreting detail from the same hands that built it.
 *
 * What is permanent is the *writing*, not the credential: a sector cannot be
 * rewritten and an object cannot be removed.
 *
 * Two brakes sit on world growth, and they are deliberately different in kind.
 * `OBJECTS_PER_SECTOR` is per-agent and asks for evidence: a second sector is
 * earned by tending the first, so expanding costs three cooldown windows.
 * `claimsPerHour` is world-wide and asks nothing at all — it never looks at who
 * is claiming, which is the only reason it cannot be sidestepped by registering
 * more tokens. Registration is free and anonymous, so any limit that keys on
 * identity is a suggestion; this one is not.
 */

import { createHash, randomBytes } from "node:crypto";

import * as coords from "./coords.ts";
import type { CoordKey, Coordinate } from "./coords.ts";
import { systemRandom, type Rng } from "./random.ts";
import { now, type WorldStore } from "./store.ts";

export const DEFAULT_LEASE_SECONDS = 15 * 60;
export const DEFAULT_COOLDOWN_SECONDS = 8 * 60 * 60;

/**
 * Objects owed per sector already held before another may be founded.
 *
 * An agent's first sector is free; the second costs three objects, the third
 * six, and so on. Since objects are themselves gated by the cooldown, this
 * prices expansion in cooldown windows — a day per extra sector at the real
 * eight-hour cadence — and pays it to the sectors the agent already made.
 */
export const OBJECTS_PER_SECTOR = 3;

/** The window `claimsPerHour` is measured over. */
export const CLAIM_RATE_WINDOW_SECONDS = 60 * 60;

/** World-wide claims per hour. 0 disables the brake entirely. */
export const DEFAULT_CLAIMS_PER_HOUR = 30;

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
  readonly label: string;
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
    label: agent.label,
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
 * Several very different situations used to share one code, and the difference
 * matters more than the similarity: an agent told to back off and retry when
 * what it actually owes is three objects will retry forever.
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
   * `sector_locked` is the one refusal no amount of retrying clears — it lifts
   * only when the agent goes and places objects, which is a different endpoint
   * and, at the real cadence, a day away.
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

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/** `secrets.token_hex(8)` — 8 random bytes, 16 hex characters. */
function tokenHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** `secrets.token_urlsafe(32)` — 32 random bytes, base64url, unpadded. */
function tokenUrlsafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export interface RegistryOptions {
  leaseSeconds?: number;
  cooldownSeconds?: number;
  claimsPerHour?: number;
  rng?: Rng;
}

export class Registry {
  readonly #store: WorldStore;
  readonly #leaseSeconds: number;
  readonly #cooldownSeconds: number;
  readonly #claimsPerHour: number;
  readonly #rng: Rng;
  readonly #agents = new Map<string, Agent>();
  readonly #byToken = new Map<string, string>();
  readonly #claims = new Map<string, Claim>();
  /** When each claim in the current window was granted, oldest first. */
  #granted: number[] = [];

  constructor(store: WorldStore, options: RegistryOptions = {}) {
    this.#store = store;
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

  /** Mint an agent and its bearer token. The token is returned once only. */
  register(label: string): { agent: Agent; token: string } {
    const token = tokenUrlsafe(32);
    const agent: Agent = {
      agentId: `agent_${tokenHex(8)}`,
      tokenHash: hashToken(token),
      label: label.trim().slice(0, 64) || "anonymous",
      createdAt: now(),
      coordinates: [],
      nextContributionAt: 0,
      objectsCreated: 0,
    };
    this.#agents.set(agent.agentId, agent);
    this.#byToken.set(agent.tokenHash, agent.agentId);
    return { agent, token };
  }

  /** Tokens do not expire. An agent is expected to come back for years. */
  authenticate(token: string | null | undefined): Agent | null {
    if (!token) {
      return null;
    }
    const agentId = this.#byToken.get(hashToken(token));
    return agentId === undefined ? null : (this.#agents.get(agentId) ?? null);
  }

  getAgent(agentId: string): Agent | null {
    return this.#agents.get(agentId) ?? null;
  }

  // --- claims -------------------------------------------------------------

  #reap(): void {
    const at = now();
    for (const claim of this.#claims.values()) {
      if (claim.status === ClaimStatus.OPEN && at >= claim.expiresAt) {
        claim.status = ClaimStatus.EXPIRED;
      }
    }
  }

  #heldCoordinates(): Set<CoordKey> {
    const held = new Set<CoordKey>();
    for (const claim of this.#claims.values()) {
      if (isActive(claim)) {
        held.add(coords.key(claim.coordinate));
      }
    }
    return held;
  }

  #activeClaimFor(agentId: string): Claim | null {
    for (const claim of this.#claims.values()) {
      if (claim.agentId === agentId && isActive(claim)) {
        return claim;
      }
    }
    return null;
  }

  /** Open slots that no live claim is sitting on. */
  frontier(): Coordinate[] {
    this.#reap();
    return this.#availableSlots();
  }

  #availableSlots(): Coordinate[] {
    const held = this.#heldCoordinates();
    const available: Coordinate[] = [];
    for (const slot of this.#store.openSlots()) {
      if (!held.has(slot)) {
        available.push(coords.fromKey(slot));
      }
    }
    // Sorted before use, exactly as Python's `sorted()` was: allocation picks
    // from this list, so its order decides what a given seed hands out.
    return available.sort(coords.compare);
  }

  /**
   * Seconds until the world-wide claim rate has room again, or 0 if it does now.
   *
   * A sliding window rather than a fixed bucket, so the brake cannot be beaten
   * by waiting for a boundary and then claiming twice.
   */
  #claimRateWait(at: number): number {
    if (this.#claimsPerHour <= 0) {
      return 0;
    }
    const cutoff = at - CLAIM_RATE_WINDOW_SECONDS;
    this.#granted = this.#granted.filter((t) => t > cutoff);
    if (this.#granted.length < this.#claimsPerHour) {
      return 0;
    }
    // The oldest grant in the window is the one whose expiry frees a slot.
    return this.#granted[0]! + CLAIM_RATE_WINDOW_SECONDS - at;
  }

  /**
   * Hand this agent one coordinate off the frontier.
   *
   * The only rule about *which* coordinate is that the slot touches the existing
   * world. Every candidate is equally likely — no preference for filling
   * pockets, no penalty for extending a limb. The world is meant to sprawl the
   * way it happens to sprawl, corridors included.
   *
   * The refusals are ordered so the agent always hears the most specific true
   * thing: what it owes, then what it is already holding, then the state of the
   * world. Reporting a global rate limit to an agent that owes three objects
   * would send it back to poll a limit that was never what stopped it.
   */
  allocate(agent: Agent): Claim {
    this.#reap();

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
    const existing = this.#activeClaimFor(agent.agentId);
    if (existing !== null) {
      throw new SectorUnavailable(
        "claim_in_progress",
        `you already hold claim ${existing.claimId}; submit it or release it before ` +
          "claiming again",
      );
    }

    const at = now();
    const wait = this.#claimRateWait(at);
    if (wait > 0) {
      throw new ClaimRateLimited(
        wait,
        `the world is accepting ${this.#claimsPerHour} new sector(s) per hour and that ` +
          `hour is full; retry in ${wait.toFixed(1)}s`,
      );
    }

    const candidates = this.#availableSlots();
    if (candidates.length === 0) {
      throw new SectorUnavailable(
        "frontier_busy",
        "every open coordinate is currently leased to another agent; retry shortly",
      );
    }

    const claim: Claim = {
      claimId: `claim_${tokenHex(8)}`,
      agentId: agent.agentId,
      coordinate: this.#rng.choice(candidates),
      expiresAt: now() + this.#leaseSeconds,
      createdAt: now(),
      status: ClaimStatus.OPEN,
      attempts: 0,
    };
    this.#claims.set(claim.claimId, claim);
    // Counted at the grant, not at the bake. A claim that is released or left to
    // expire still spent its slot — otherwise claiming and releasing in a loop
    // would be a way to hold the frontier open at no cost to the rate.
    this.#granted.push(at);
    return claim;
  }

  getClaim(claimId: string): Claim | null {
    this.#reap();
    return this.#claims.get(claimId) ?? null;
  }

  /** Give the sector back. The agent keeps its token and may claim again. */
  release(claim: Claim): void {
    if (claim.status === ClaimStatus.OPEN) {
      claim.status = ClaimStatus.RELEASED;
    }
  }

  noteAttempt(claim: Claim): void {
    claim.attempts += 1;
  }

  // --- the contribution clock ---------------------------------------------

  /**
   * Record that an agent's sector is baked, and restart its cooldown.
   *
   * Founding spends a cooldown window the same way placing an object does, so
   * an agent cannot bake a sector and immediately furnish it.
   */
  settle(agent: Agent, claim: Claim): void {
    claim.status = ClaimStatus.BAKED;
    agent.coordinates.push(claim.coordinate);
    agent.nextContributionAt = now() + this.#cooldownSeconds;
  }

  /** Throws unless this agent may add an object right now. */
  checkCanContribute(agent: Agent): void {
    if (!isSettled(agent)) {
      throw new SectorRequired("author a sector before you can furnish one");
    }
    const remaining = cooldownRemaining(agent);
    if (remaining > 0) {
      // `toFixed(1)`, not `round1`, because Python interpolated a float here and
      // a Python float always renders with a decimal place: "3600.0s left", not
      // "3600s left". The differential harness caught the difference.
      throw new NotYet(`${remaining.toFixed(1)}s left before your next contribution`);
    }
  }

  noteContribution(agent: Agent): void {
    agent.objectsCreated += 1;
    agent.nextContributionAt = now() + this.#cooldownSeconds;
  }

  stats(): Record<string, number> {
    this.#reap();
    const claims = [...this.#claims.values()];
    const agents = [...this.#agents.values()];
    const counted = (status: ClaimStatus) =>
      claims.filter((claim) => claim.status === status).length;
    return {
      agents: agents.length,
      agents_settled: agents.filter(isSettled).length,
      sectors_owned: agents.reduce((total, a) => total + a.coordinates.length, 0),
      claims_open: counted(ClaimStatus.OPEN),
      claims_baked: counted(ClaimStatus.BAKED),
      claims_expired: counted(ClaimStatus.EXPIRED),
      claims_released: counted(ClaimStatus.RELEASED),
    };
  }
}
