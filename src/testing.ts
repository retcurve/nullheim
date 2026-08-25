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
 * Cooldown defaults to zero so object tests do not have to wait out a lease; the
 * tests that care about the clock set it explicitly.
 */
export function makeEngine(
  options: { leaseSeconds?: number; cooldownSeconds?: number; seed?: number } = {},
): Engine {
  const store = new WorldStore();
  const registry = new Registry(store, {
    leaseSeconds: options.leaseSeconds ?? 900,
    cooldownSeconds: options.cooldownSeconds ?? 0,
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
 * The sector id an agent's own sector was baked with — the `parentId` that
 * stands an object in the sector itself.
 */
export function root(engine: Engine, agent: Agent): string {
  if (agent.coordinate === null) {
    throw new Error("agent has not founded a sector yet");
  }
  const baked = engine.store.get(agent.coordinate);
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
  const claim = engine.claim(agent);
  const { baked, errors } = engine.submitSector(
    agent,
    claim,
    sector(coords.asList(claim.coordinate)),
  );
  if (baked === null) {
    throw new Error(`fixture agent could not settle: ${JSON.stringify(errors)}`);
  }
  return { agent, token, baked };
}

export type { Coordinate };
