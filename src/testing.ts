/**
 * Shared fixtures for the test suite.
 *
 * The port of `tests/helpers.py`. Kept in `src/` rather than a separate tests
 * tree so the imports are ordinary relative ones and the typechecker sees the
 * fixtures and the code they exercise as one program.
 */

import * as coords from "./coords.ts";
import type { Coordinate } from "./coords.ts";
import { Engine } from "./engine.ts";
import type { ValidationError } from "./errors.ts";
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

/**
 * A fresh in-memory world with a deterministic frontier allocator.
 *
 * Cooldown defaults to zero so object tests do not have to wait out a lease, and
 * the world-wide claim rate is uncapped so a test that founds a few hundred
 * sectors does not trip a brake it was not written to exercise. The tests that
 * care about either clock set it explicitly.
 */
export function makeEngine(
  options: {
    leaseSeconds?: number;
    cooldownSeconds?: number;
    claimsPerHour?: number;
    seed?: number;
  } = {},
): Engine {
  const store = new WorldStore();
  const registry = new Registry(store, {
    leaseSeconds: options.leaseSeconds ?? 900,
    cooldownSeconds: options.cooldownSeconds ?? 0,
    claimsPerHour: options.claimsPerHour ?? 0,
    rng: seeded(options.seed ?? 1),
  });
  return new Engine({ store, registry });
}

/**
 * Bake a sector straight into the store, bypassing claim allocation.
 *
 * Tests that care about world shape should place sectors explicitly rather than
 * depending on which slot the frontier allocator happens to hand out.
 */
export function build(
  engine: Engine,
  at: readonly [number, number],
  options: { agentId?: string; overrides?: Record<string, unknown> } = {},
): BakedSector {
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
  engine.store.bake(baked);
  return baked;
}

/**
 * The sector id one of an agent's own sectors was baked with — the `parentId`
 * that stands an object in that sector itself. Defaults to the first sector the
 * agent founded, which is the only one most fixtures have.
 */
export function root(engine: Engine, agent: Agent, index = 0): string {
  const coordinate = agent.coordinates[index];
  if (coordinate === undefined) {
    throw new Error("agent has not founded that many sectors yet");
  }
  const baked = engine.store.get(coordinate);
  if (baked === null) {
    throw new Error("agent has not founded a sector yet");
  }
  return baked.sectorId;
}

/** Register an agent and take it all the way through founding its sector. */
export function settle(
  engine: Engine,
  label = "tester",
): { agent: Agent; token: string; baked: BakedSector } {
  const { agent, token } = engine.register(label);
  const baked = found(engine, agent);
  return { agent, token, baked };
}

/** Take an already-registered agent through founding one more sector. */
export function found(engine: Engine, agent: Agent): BakedSector {
  const claim = engine.claim(agent);
  const { baked, errors } = engine.submitSector(
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
export function furnish(engine: Engine, agent: Agent, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const { object, errors } = engine.createObject(
      agent,
      obj(root(engine, agent), { title: `A Thing ${i}` }),
    );
    if (object === null) {
      throw new Error(`fixture object ${i} rejected: ${JSON.stringify(errors)}`);
    }
  }
}

export type { Coordinate };
