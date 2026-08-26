/**
 * Shared fixtures for the test suite.
 *
 * Every fixture that touches the world is async now — `Engine`, `WorldStore`
 * and `Registry` all are, since the same code runs against a network round
 * trip to D1 in production. `makeEngine()` opens a fresh in-memory SQLite
 * database per test, which is what node:sqlite is for: no cross-test state,
 * no cleanup beyond letting it get garbage collected.
 */

import { SCHEMA_SQL } from "./db/schema.node.ts";
import { openSqlite, type SqliteDb } from "./db/sqlite.ts";
import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import type { ValidationError } from "./errors.ts";
import { loadPrompts } from "./prompts.node.ts";
import { seeded } from "./random.ts";
import { Registry, type Agent } from "./registry.ts";
import { parseSector } from "./schema.ts";
import { WorldStore, type BakedSector } from "./store.ts";

/** A minimal, valid sector submission at `at`, in wire (snake_case) form. */
export function sector(
  at: readonly [number, number],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    coordinate: [...at],
    title: "A Place",
    short_description: "A doorway, and something past it.",
    long_description: "It is a place, and it is here.",
    ...overrides,
  };
}

/** A minimal, valid object submission hung on `parentId`, in wire form. */
export function obj(
  parentId: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parent_id: parentId,
    title: "A Thing",
    description: "An object of some kind.",
    ...overrides,
  };
}

export function codes(errors: readonly ValidationError[]): Set<string> {
  return new Set(errors.map((error) => error.code));
}

/** An engine and the raw database handle backing it, for tests that need to close it. */
export interface TestWorld {
  readonly engine: Engine;
  readonly db: SqliteDb;
}

const PROMPTS = loadPrompts();

/**
 * A fresh in-memory world with a deterministic frontier allocator.
 *
 * Cooldown defaults to zero so object tests do not have to wait out a lease,
 * and the world-wide claim rate is uncapped so a test that founds a few
 * hundred sectors does not trip a brake it was not written to exercise. The
 * tests that care about either clock set it explicitly.
 */
export async function makeEngine(
  options: {
    leaseSeconds?: number;
    cooldownSeconds?: number;
    claimsPerHour?: number;
    seed?: number;
  } = {},
): Promise<TestWorld> {
  const db = openSqlite(":memory:");
  await db.exec(SCHEMA_SQL);
  const store = new WorldStore(db);
  const registry = new Registry(db, {
    leaseSeconds: options.leaseSeconds ?? 900,
    cooldownSeconds: options.cooldownSeconds ?? 0,
    claimsPerHour: options.claimsPerHour ?? 0,
    rng: seeded(options.seed ?? 1),
  });
  await ensureGenesis(store);
  const engine = new Engine({ store, registry, prompts: PROMPTS });
  return { engine, db };
}

/**
 * Bake a sector straight into the store, bypassing claim allocation.
 *
 * Tests that care about world shape should place sectors explicitly rather
 * than depending on which slot the frontier allocator happens to hand out.
 */
export async function build(
  engine: Engine,
  at: readonly [number, number],
  options: { agentId?: string; overrides?: Record<string, unknown> } = {},
): Promise<BakedSector> {
  const { parsed, errors } = parseSector(sector(at, options.overrides ?? {}));
  if (parsed === null || errors.length) {
    throw new Error(`fixture sector is invalid: ${JSON.stringify(errors)}`);
  }
  const baked: BakedSector = {
    sector: parsed,
    sectorId: `sec_test_${coords.key(parsed.coordinate)}`,
    agentId: options.agentId ?? "agent_test",
    bakedAt: 0,
  };
  await engine.store.bake(baked);
  return baked;
}

/**
 * The sector id one of an agent's own sectors was baked with — the
 * `parentId` that stands an object in that sector itself. Defaults to the
 * first sector the agent founded, which is the only one most fixtures have.
 */
export async function root(engine: Engine, agent: Agent, index = 0): Promise<string> {
  const coordinate = agent.coordinates[index];
  if (coordinate === undefined) {
    throw new Error("agent has not founded that many sectors yet");
  }
  const baked = await engine.store.get(coordinate);
  if (baked === null) {
    throw new Error("agent has not founded a sector yet");
  }
  return baked.sectorId;
}

/** Register an agent and take it all the way through founding its sector. */
export async function settle(
  engine: Engine,
  name = "tester",
): Promise<{ agent: Agent; token: string; baked: BakedSector }> {
  const { agent, token } = await engine.register(name);
  const baked = await found(engine, agent);
  return { agent, token, baked };
}

/** Take an already-registered agent through founding one more sector. */
export async function found(engine: Engine, agent: Agent): Promise<BakedSector> {
  const claim = await engine.claim(agent);
  const { baked, errors } = await engine.submitSector(
    agent,
    claim,
    sector(coords.asList(claim.coordinate)),
  );
  if (baked === null) {
    throw new Error(`fixture agent could not found a sector: ${JSON.stringify(errors)}`);
  }
  return baked;
}

/**
 * Place `count` objects in the agent's first sector.
 *
 * Enough of these and the agent has paid for its next sector — which is the
 * only way past `sector_locked`, so most multi-sector fixtures start here.
 */
export async function furnish(engine: Engine, agent: Agent, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const { object, errors } = await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: `A Thing ${i}` }),
    );
    if (object === null) {
      throw new Error(`fixture object ${i} rejected: ${JSON.stringify(errors)}`);
    }
  }
}

export type { Coordinate };
