/**
 * Shared fixtures for the test suite.
 *
 * Every fixture that touches the world is async: `Engine`, `WorldStore` and
 * `Registry` all use async methods. `makeEngine()` opens a fresh in-memory
 * SQLite database per test with no cleanup beyond garbage collection.
 */

import { deflateSync } from "node:zlib";

import { SCHEMA_SQL } from "../src/db/schema.node.ts";
import { openSqlite, type SqliteDb } from "../src/db/sqlite.ts";
import * as coords from "../src/coords.ts";
import type { Coordinate } from "../src/coords.ts";
import { Engine, ensureGenesis } from "../src/engine.ts";
import type { ValidationError } from "../src/errors.ts";
import { openFsImages } from "../src/images/fs.ts";
import type { Moderator } from "../src/moderation.ts";
import { permissiveModerator } from "../src/moderation/permissive.ts";
import { loadPrompts } from "../src/prompts.node.ts";
import { seeded } from "../src/random.ts";
import { Registry, type Agent } from "../src/registry.ts";
import { parseSector } from "../src/schema.ts";
import { WorldStore, type BakedSector } from "../src/store.ts";
import { loadCodecs } from "../src/wasm.node.ts";

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

/** A minimal, valid interaction submission between two objects, in wire form. */
export function interaction(
  objectAId: unknown,
  objectBId: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    object_a_id: objectAId,
    object_b_id: objectBId,
    text: "What a player sees on use A with B.",
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
// Compiled once and reused across the whole test run.
const CODECS = loadCodecs();

/**
 * A fresh in-memory world with a deterministic frontier allocator.
 *
 * Cooldown defaults to zero and the world-wide claim rate defaults to
 * uncapped. Tests that need either can set it explicitly.
 */
export async function makeEngine(
  options: {
    leaseSeconds?: number;
    cooldownSeconds?: number;
    claimsPerHour?: number;
    registrationsPerHour?: number;
    seed?: number;
    moderator?: Moderator;
  } = {},
): Promise<TestWorld> {
  const db = openSqlite(":memory:");
  await db.exec(SCHEMA_SQL);
  const store = new WorldStore(db);
  const registry = new Registry(db, {
    leaseSeconds: options.leaseSeconds ?? 900,
    cooldownSeconds: options.cooldownSeconds ?? 0,
    claimsPerHour: options.claimsPerHour ?? 0,
    registrationsPerHour: options.registrationsPerHour ?? 0,
    rng: seeded(options.seed ?? 1),
  });
  await ensureGenesis(store);
  const engine = new Engine({
    store,
    registry,
    prompts: PROMPTS,
    images: openFsImages(null),
    codecs: CODECS,
    moderator: options.moderator ?? permissiveModerator("clean"),
  });
  return { engine, db };
}

/** Bake a sector straight into the store, bypassing claim allocation. */
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
  await engine.store.bake(baked, null);
  return baked;
}

/**
 * The sector id one of an agent's own sectors was baked with, usable as an
 * object's `parentId`. Defaults to the first sector the agent founded.
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

/** Place `count` objects in the agent's first sector. */
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

/** Builds a minimal, valid RGBA PNG at `width` x `height`, deflate-compressed. */
export function makePng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((1 + width * 4) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = Math.floor((x * 255) / width);
      raw[offset + 1] = Math.floor((y * 255) / height);
      raw[offset + 2] = 128;
      raw[offset + 3] = 255;
    }
  }
  const idat = deflateSync(raw);

  function chunk(type: string, data: Buffer): Buffer {
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    // CRC32 over type+data, computed inline.
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc ^= byte;
      for (let i = 0; i < 8; i += 1) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc);
    return Buffer.concat([length, typeAndData, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(
    Buffer.concat([
      signature,
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

export type { Coordinate };
