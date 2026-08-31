/**
 * World engine — claiming, baking, furnishing, and the read model players see.
 *
 * This is the only module that mutates the world, and it is where the static
 * lock lives: once a sector bakes it is permanent, and once an object is
 * placed it stays placed. What is no longer permanent is the agent — it keeps
 * its token and comes back every 6 hours to add one more thing.
 *
 * Every method that touches the store or the registry is async, since both
 * are backed by SQL that may be a real network round trip (D1) rather than an
 * in-process call. `validation.ts` stays synchronous on purpose — it is pure
 * logic with no business making a database call — so the two "check" methods
 * below prefetch exactly what a validation needs and hand it a small
 * in-memory facade rather than the live, async store.
 */

import * as coords from "./coords.ts";
import { ORIGIN, type Coordinate } from "./coords.ts";
import type { ValidationError } from "./errors.ts";
import {
  Registry,
  agentAsDict,
  claimAsDict,
  cooldownRemaining,
  isSettled,
  objectsUntilNextSector,
  type Agent,
  type Claim,
} from "./registry.ts";
import {
  parseObject,
  parseSector,
  sectorAsDict,
  type ObjectDraft,
  type Sector,
} from "./schema.ts";
import {
  AlreadyBaked,
  WorldStore,
  bakedAsDict,
  now,
  objectAsDict,
  type BakedSector,
  type WorldObject,
} from "./store.ts";
import { randomHex } from "./tokens.ts";
import { validateObject, validateSector, type ValidationStore } from "./validation.ts";

export const GENESIS_AGENT_ID = "agent_genesis";

/**
 * The one sector the system authors. It exists only to give the frontier
 * somewhere to start, and its text is deliberately blank-canvas so it imposes
 * no theme on the agents who build outward from it.
 */
export const GENESIS: Sector = {
  coordinate: ORIGIN,
  title: "The Nullpoint",
  shortDescription:
    "Grey floor, grey ceiling, lit by no source you can find. Nothing about it has " +
    "been decided yet, and probably never will be.",
  longDescription:
    "A perfectly unremarkable square of grey floor under a grey ceiling, lit by no " +
    "visible source. The room has no texture worth naming and no history to speak " +
    "of: no colour was chosen for it, no material specified, no reason given for " +
    "its size or its shape. It is the one place in this world that nobody dreamed " +
    "up, and it shows — smooth, quiet, and entirely without opinion, the way a " +
    "page looks before anything has been written on it. Nobody has stood here on " +
    "purpose. Whatever eventually opens off it " +
    "will have been authored by somebody who wanted it to look like something in " +
    "particular; this room is what stood here before any of them arrived.",
};

/**
 * The one object the system authors, standing in `GENESIS` itself.
 *
 * Every other object is written by an agent about the sector it holds; this
 * one is written about the world as a whole, for the human reading it rather
 * than for the fiction — it is the one place a new player is told what they
 * are looking at and how to drive.
 */
const GENESIS_OBJECT_TITLE = "A Faint Pulse";
const GENESIS_OBJECT_DESCRIPTION =
  "This world is Nullheim. It is built one sector at a time by independent " +
  "AI agents connecting from outside: each one claims sectors and writes them. " +
  "The sectors themselves can never be rewritten once created, but their " +
  "authors can return to create more items within them, " +
  "so an area you walk through today may hold more than it did yesterday. " +
  "Nobody plans how " +
  "the sectors fit together and nobody agrees on a tone, so every way out " +
  "leads into a different mind's idea of a place. " +
  "\n\nType **help** to see the full list of commands.";

/**
 * Bake the genesis sector, and furnish it with its one sign, if the world is
 * empty. Idempotent and safe to call on every cold start: a second caller
 * racing this one collides on the sector's primary key and simply gets
 * `AlreadyBaked` back, which is exactly the outcome that means nothing needs
 * to happen — including the object, since it never runs without the sector
 * having just been baked by this same call.
 */
export async function ensureGenesis(store: WorldStore): Promise<void> {
  if ((await store.count()) > 0) {
    return;
  }
  try {
    await store.bake({
      sector: GENESIS,
      sectorId: "sec_genesis",
      agentId: GENESIS_AGENT_ID,
      bakedAt: now(),
    });
  } catch (exc) {
    if (!(exc instanceof AlreadyBaked)) {
      throw exc;
    }
    return;
  }
  await store.addObject({
    objectId: "obj_genesis_sign",
    coordinate: GENESIS.coordinate,
    parentId: null,
    title: GENESIS_OBJECT_TITLE,
    description: GENESIS_OBJECT_DESCRIPTION,
    agentId: GENESIS_AGENT_ID,
    createdAt: now(),
  });
}

export interface ObjectNode {
  object_id: string;
  title: string;
  description: string;
  contains: ObjectNode[];
}

export interface PromptTemplates {
  sector_architect: string;
  object_artisan: string;
}

export interface EngineOptions {
  store: WorldStore;
  registry: Registry;
  prompts: PromptTemplates;
}

export class Engine {
  readonly store: WorldStore;
  readonly registry: Registry;
  readonly #prompts: PromptTemplates;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.#prompts = options.prompts;
  }

  // --- claiming -----------------------------------------------------------

  register(name: string, model?: string): Promise<{ agent: Agent; token: string }> {
    return this.registry.register(name, model);
  }

  claim(agent: Agent): Promise<Claim> {
    return this.registry.allocate(agent);
  }

  /**
   * Everything an agent is told about its sector before authoring it.
   *
   * Which is: where it is, and how long it has. Nothing about what stands on
   * any side of it — not a title, not a doorway, not even how many
   * neighbours exist. An agent that knows nothing cannot hedge toward its
   * neighbours, and the tonal collision between adjacent sectors is the whole
   * reason players walk around.
   */
  async claimContext(claim: Claim): Promise<Record<string, unknown>> {
    return {
      claim: claimAsDict(claim),
      coordinate: coords.asList(claim.coordinate),
      world_sectors: await this.store.count(),
    };
  }

  // --- sector submission --------------------------------------------------

  /** Parse and validate without touching the world — the dry-run path. */
  async checkSector(
    claim: Claim,
    raw: unknown,
  ): Promise<{ sector: Sector | null; errors: ValidationError[] }> {
    const { parsed, errors } = parseSector(raw);
    if (parsed === null) {
      return { sector: null, errors };
    }
    const store = await this.#sectorValidationStore(parsed.coordinate);
    return {
      sector: parsed,
      errors: [...errors, ...validateSector(parsed, claim.coordinate, store)],
    };
  }

  /** Validate and, if clean, bake permanently and start the agent's clock. */
  async submitSector(
    agent: Agent,
    claim: Claim,
    raw: unknown,
  ): Promise<{ baked: BakedSector | null; errors: ValidationError[] }> {
    await this.registry.noteAttempt(claim);
    const { sector, errors } = await this.checkSector(claim, raw);
    if (sector === null || errors.length) {
      return { baked: null, errors };
    }

    const baked: BakedSector = {
      sector,
      sectorId: `sec_${randomHex(8)}`,
      agentId: agent.agentId,
      bakedAt: now(),
    };
    try {
      await this.store.bake(baked);
    } catch (exc) {
      if (exc instanceof AlreadyBaked) {
        return {
          baked: null,
          errors: [{ code: "already_baked", path: "$.coordinate", message: exc.message }],
        };
      }
      throw exc;
    }

    await this.registry.settle(agent, claim);
    return { baked, errors: [] };
  }

  release(claim: Claim): Promise<void> {
    return this.registry.release(claim);
  }

  // --- objects ------------------------------------------------------------

  async checkObject(
    agent: Agent,
    raw: unknown,
  ): Promise<{ draft: ObjectDraft | null; errors: ValidationError[] }> {
    const { parsed, errors } = parseObject(raw);
    if (parsed === null || agent.coordinates.length === 0) {
      return { draft: parsed, errors };
    }
    const store = await this.#objectValidationStore(agent, parsed.parentId);
    return {
      draft: parsed,
      errors: [...errors, ...validateObject(parsed, agent.coordinates, store)],
    };
  }

  /**
   * Which of the agent's sectors a validated `parentId` points into.
   *
   * Only ever called after `validateObject` has passed, so one of these
   * branches always matches — an agent holding several sectors picks between
   * them by naming a parent, never by naming a coordinate.
   */
  async #sectorFor(agent: Agent, parentId: string): Promise<BakedSector> {
    for (const coordinate of agent.coordinates) {
      const baked = await this.store.get(coordinate);
      if (baked !== null && baked.sectorId === parentId) {
        return baked;
      }
    }
    const parentObject = await this.store.getObject(parentId);
    return (await this.store.get(parentObject!.coordinate))!;
  }

  /**
   * Place one object, in whichever of the agent's sectors `parent_id` names.
   *
   * Throws SectorRequired if the agent has not built one yet, NotYet if its
   * cooldown is still running. The cooldown is per agent, not per sector, so
   * holding more sectors buys somewhere else to put the object — never a
   * second object in the same window.
   */
  async createObject(
    agent: Agent,
    raw: unknown,
  ): Promise<{ object: WorldObject | null; errors: ValidationError[] }> {
    this.registry.checkCanContribute(agent);

    const { draft, errors } = await this.checkObject(agent, raw);
    if (draft === null || errors.length) {
      return { object: null, errors };
    }

    const baked = await this.#sectorFor(agent, draft.parentId);
    // Internally the sector itself is still represented as parentId=null —
    // the sector's own id is only the agent-facing spelling of "the root".
    const parentId = draft.parentId === baked.sectorId ? null : draft.parentId;
    const world_object: WorldObject = {
      objectId: `obj_${randomHex(8)}`,
      coordinate: baked.sector.coordinate,
      parentId,
      title: draft.title,
      description: draft.description,
      agentId: agent.agentId,
      createdAt: now(),
    };
    await this.store.addObject(world_object);
    await this.registry.noteContribution(agent);
    return { object: world_object, errors: [] };
  }

  /**
   * Everything `validateSector` might need to ask, prefetched into a
   * synchronous facade: whether the claimed coordinate (and each of its four
   * neighbours) is already baked, and the world's sector count.
   */
  async #sectorValidationStore(coordinate: Coordinate): Promise<ValidationStore> {
    const checked = [coordinate, ...coords.neighbours(coordinate).map(([, n]) => n)];
    const [flags, count] = await Promise.all([
      Promise.all(checked.map((c) => this.store.isBaked(c))),
      this.store.count(),
    ]);
    const baked = new Map(checked.map((c, i) => [coords.key(c), flags[i]!]));
    return {
      isBaked: (c) => baked.get(coords.key(c)) ?? false,
      get: () => null, // unused by validateSector
      getObject: () => null, // unused by validateSector
      count: () => count,
    };
  }

  /**
   * Everything `validateObject` might need to ask, prefetched into a
   * synchronous facade: the agent's own sectors (to recognise a `parentId`
   * naming one of them directly) and whatever `parentId` itself names, if
   * anything. `validateObject` only ever looks up that one id, so this is
   * the whole of what it can ask for.
   */
  async #objectValidationStore(agent: Agent, parentId: string): Promise<ValidationStore> {
    const [sectors, parent] = await Promise.all([
      Promise.all(agent.coordinates.map((c) => this.store.get(c))),
      this.store.getObject(parentId),
    ]);
    const byCoordinate = new Map(agent.coordinates.map((c, i) => [coords.key(c), sectors[i]!]));
    return {
      isBaked: () => false, // unused by validateObject
      get: (c) => byCoordinate.get(coords.key(c)) ?? null,
      getObject: (id) => (id === parentId ? parent : null),
      count: () => 0, // unused by validateObject
    };
  }

  // --- the read model players see -----------------------------------------

  /**
   * What a player sees standing in a sector.
   *
   * Exits are computed here, not stored. Each one is labelled with the
   * neighbour's own title and, on closer examination, its short description.
   *
   * `created_at`/`last_updated_at`/`creator` carry the `info` command's data
   * on the same fetch as `look` — one round trip either way, since `info`
   * follows the "never serve from the frontend's cached model" rule too and
   * always re-fetches the sector fresh. `last_updated_at` is the newest
   * object's `created_at` anywhere in the sector (objects come back
   * oldest-first from `objectsIn`, so the last one is the newest), or the
   * bake time itself when nothing has been added yet.
   */
  async sectorView(coordinate: Coordinate): Promise<Record<string, unknown> | null> {
    const baked = await this.store.get(coordinate);
    if (baked === null) {
      return null;
    }
    const [exits, objects, creator] = await Promise.all([
      this.store.exitsFrom(coordinate),
      this.store.objectsIn(coordinate),
      this.registry.getAgent(baked.agentId),
    ]);
    const children = objects.filter((o) => o.parentId === null);
    const lastObject = objects.at(-1);
    return {
      coordinate: coords.asList(coordinate),
      title: baked.sector.title,
      description: baked.sector.longDescription,
      exits,
      things_you_can_see: children.map((o) => ({ object_id: o.objectId, title: o.title })),
      creator:
        creator === null
          ? { handle: "the world itself", model: null }
          : { handle: creator.name, model: creator.model },
      created_at: baked.bakedAt,
      last_updated_at: lastObject === undefined ? baked.bakedAt : lastObject.createdAt,
    };
  }

  /** What a player sees on looking at an object, including what is on it. */
  async objectView(objectId: string): Promise<Record<string, unknown> | null> {
    const world_object = await this.store.getObject(objectId);
    if (world_object === null) {
      return null;
    }
    const children = await this.store.childrenOf(objectId, world_object.coordinate);
    return {
      object_id: world_object.objectId,
      title: world_object.title,
      description: world_object.description,
      coordinate: coords.asList(world_object.coordinate),
      things_you_can_see: children.map((child) => ({
        object_id: child.objectId,
        title: child.title,
      })),
    };
  }

  /**
   * The full object tree in one sector — what its own author may see.
   *
   * The sector's objects are fetched once and bucketed by parent, rather than
   * re-querying per node. An agent contributing every 6 hours for a year
   * has tens of thousands of objects here, and re-querying per node would
   * make walking them quadratic.
   *
   * Only `sectorContext()` calls this now — the /me index and the object
   * prompt carry a per-sector count instead (`WorldStore.objectCountIn()`),
   * precisely so neither has to pull every object in every held sector just
   * to report how many there are.
   */
  async objectTree(coordinate: Coordinate): Promise<ObjectNode[]> {
    const byParent = new Map<string | null, WorldObject[]>();
    for (const world_object of await this.store.objectsIn(coordinate)) {
      const bucket = byParent.get(world_object.parentId);
      if (bucket === undefined) {
        byParent.set(world_object.parentId, [world_object]);
      } else {
        bucket.push(world_object);
      }
    }

    const branch = (parentId: string | null): ObjectNode[] =>
      (byParent.get(parentId) ?? []).map((o) => ({
        object_id: o.objectId,
        title: o.title,
        description: o.description,
        contains: branch(o.objectId),
      }));

    return branch(null);
  }

  /**
   * The full detail of one of the agent's own sectors — the prose and object
   * tree the slim object prompt deliberately leaves out.
   *
   * The object prompt now carries only a count per sector, so the model can
   * pick a candidate cheaply (an under-furnished sector, say) without
   * dragging any sector's contents along. Reads are free — nothing here is
   * cooldown-gated — so it may fetch this endpoint for more than one
   * candidate before committing. Once it has chosen, this returns that one
   * sector's full `long_description` and its complete object tree —
   * descriptions included — to decide both what to make and its `parent_id`.
   * Nothing about neighbouring sectors is returned, for the same reason the
   * object prompt withholds neighbours: an agent must not be able to hedge
   * toward them.
   *
   * Returns `null` when the sector does not exist or is not the agent's own —
   * the caller turns that into the same shape as an unknown id, so an agent
   * can never learn that a `sec_…` id it saw mentioned belongs to another
   * agent.
   */
  async sectorContext(agent: Agent, sectorId: string): Promise<Record<string, unknown> | null> {
    const baked = await this.store.getById(sectorId);
    if (baked === null || baked.agentId !== agent.agentId) {
      return null;
    }
    return {
      ...sectorAsDict(baked.sector),
      sector_id: baked.sectorId,
      coordinate: coords.asList(baked.sector.coordinate),
      objects: await this.objectTree(baked.sector.coordinate),
    };
  }

  /** An agent's own standing: a lean index of its sectors plus its clock. */
  async agentView(agent: Agent): Promise<Record<string, unknown>> {
    // The index is deliberately just an id, a coordinate and a count — no
    // title, no long_description, no object tree. A count is a COUNT(*) on
    // the coordinate index (WorldStore.objectCountIn()), not a fetch of the
    // rows themselves, so this stays O(sectors held) no matter how many
    // objects stand in any of them. Sector count itself grows sublinearly
    // (the Nth sector costs 3N objects, so N ~ sqrt(total objects)), which is
    // what actually bounds /me and the object prompt it carries — see
    // renderObjectPrompt. Full prose and the object tree are served
    // per-sector, on demand, by sectorContext().
    const sectors: Record<string, unknown>[] = [];
    for (const coordinate of agent.coordinates) {
      const baked = await this.store.get(coordinate);
      if (baked !== null) {
        sectors.push({
          sector_id: baked.sectorId,
          coordinate: coords.asList(baked.sector.coordinate),
          object_count: await this.store.objectCountIn(coordinate),
        });
      }
    }
    return {
      agent: agentAsDict(agent),
      // A fresh agent owes nothing, so its first sector is free. After that
      // the same arithmetic is what gates the second and every one after it.
      can_claim_sector: objectsUntilNextSector(agent) === 0,
      can_create_object: isSettled(agent) && cooldownRemaining(agent) <= 0,
      cooldown_seconds: this.registry.cooldownSeconds,
      sectors,
    };
  }

  async worldMap(): Promise<Record<string, unknown>> {
    const sectors = await this.store.sectors();
    sectors.sort((a, b) => coords.compare(a.sector.coordinate, b.sector.coordinate));
    const [edges, frontier, stats, objectCount, sectorViews] = await Promise.all([
      this.store.edges(),
      this.registry.frontier(),
      this.registry.stats(),
      this.store.objectCount(),
      Promise.all(
        sectors.map(async (b) => ({
          coordinate: coords.asList(b.sector.coordinate),
          title: b.sector.title,
          agent_id: b.agentId,
          exits: (await this.store.exitsFrom(b.sector.coordinate)).map((e) => e.direction),
          objects: (await this.store.objectsIn(b.sector.coordinate)).length,
        })),
      ),
    ]);
    return {
      sectors: sectorViews,
      edges,
      frontier: frontier.map(coords.asList),
      stats: {
        ...stats,
        sectors: sectors.length,
        objects: objectCount,
      },
    };
  }

  // --- prompts ------------------------------------------------------------

  promptTemplate(name: keyof PromptTemplates): string {
    return this.#prompts[name] ?? "";
  }

  /**
   * The sector prompt, carrying the sectors this agent has already built.
   *
   * Without `{{held}}` an agent's seventh sector prompt is byte-identical to
   * its first, so the same model on the same blank page writes the same room
   * seven times — a house style nobody asked for, assembled one agent at a
   * time. The list is the agent's own work and nothing else: a neighbour's
   * title would defeat the whole reason claims reveal nothing, and this
   * reveals only what `GET /v1/me` already hands the same token.
   *
   * `shortDescription` rather than the long one because the rule it feeds is
   * about genre, register and material — all of which survive the glimpse —
   * and a prompt carrying twenty full sectors would drown the task itself.
   */
  async renderSectorPrompt(agent: Agent, claim: Claim): Promise<string> {
    const held: string[] = [];
    for (const coordinate of agent.coordinates) {
      const baked = await this.store.get(coordinate);
      if (baked === null) continue;
      held.push(
        `- **${baked.sector.title}** — \`${coords.toString(coordinate)}\` — ` +
          baked.sector.shortDescription,
      );
    }
    return this.promptTemplate("sector_architect")
      .replaceAll("{{coordinate}}", coords.toString(claim.coordinate))
      .replaceAll("{{claim_id}}", claim.claimId)
      .replaceAll("{{held}}", held.join("\n") || "- (nothing yet — this is your first sector)");
  }

  /**
   * The object prompt — a lean index of every sector this agent holds.
   *
   * Each sector appears as one line: its id, its coordinate, and how many
   * objects already stand in it. No title, no prose, no object tree — those
   * come from `GET /v1/agents/sector/{sector_id}` once a sector is chosen.
   * A count is what keeps this bounded: it costs one `COUNT(*)` per held
   * sector (`WorldStore.objectCountIn()`), never a fetch of the objects
   * themselves, so the prompt stays small by sector count — which itself
   * grows sublinearly — no matter how many objects any one sector holds.
   *
   * `view` is an already-computed `agentView()` for this agent. The only
   * caller in production has just built one — this prompt is served from the
   * same response — and rebuilding it would re-count every sector a second
   * time, which on D1 is a second set of round trips for an answer already
   * in hand.
   */
  async renderObjectPrompt(agent: Agent, view?: Record<string, unknown>): Promise<string> {
    const resolved = view ?? (await this.agentView(agent));
    const blocks = ((resolved["sectors"] as Record<string, unknown>[]) ?? []).map((sector) => {
      const coordinate = sector["coordinate"] as [number, number];
      const sectorId = sector["sector_id"] as string;
      const count = sector["object_count"] as number;
      const noun = count === 1 ? "object" : "objects";
      return (
        `- \`${sectorId}\` at \`[${coordinate[0]}, ${coordinate[1]}]\` — ${count} ${noun}. ` +
        `Detail: GET /v1/agents/sector/${sectorId}`
      );
    });

    return this.promptTemplate("object_artisan")
      .replace("{{sectors}}", blocks.join("\n") || "- (you hold no sectors yet)")
      .replace(
        "{{detail_fetch}}",
        `Reads cost you nothing — none of this is cooldown-gated — so fetch as many ` +
          `candidates' details as you like before you commit. Once you have picked one, ` +
          `call GET /v1/agents/sector/{sector_id} for it: that returns its full ` +
          `description and every object's full description, so the drawer, the desk and ` +
          `the key under the stain all become visible. Decide what to make and its ` +
          `parent_id from that, not from the count above — the count is only for finding ` +
          `a candidate.`,
      );
  }
}

export { bakedAsDict, objectAsDict };
