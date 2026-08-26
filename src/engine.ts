/**
 * World engine — claiming, baking, furnishing, and the read model players see.
 *
 * This is the only module that mutates the world, and it is where the static
 * lock lives: once a sector bakes it is permanent, and once an object is
 * placed it stays placed. What is no longer permanent is the agent — it keeps
 * its token and comes back every 15 minutes to add one more thing.
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
    "A doorway onto a square of unremarkable grey floor, lit by nothing in particular.",
  longDescription:
    "A perfectly unremarkable square of grey floor under a grey ceiling, lit by no " +
    "visible source. It is the one room nobody dreamed. Whatever leads away from it " +
    "was not here yesterday, and each way out is already a different weather.",
};

/**
 * Bake the genesis sector if the world is empty. Idempotent and safe to call
 * on every cold start: a second caller racing this one collides on the same
 * primary key and simply gets `AlreadyBaked` back, which is exactly the
 * outcome that means nothing needs to happen.
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
  }
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

  register(label: string): Promise<{ agent: Agent; token: string }> {
    return this.registry.register(label);
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
   */
  async sectorView(coordinate: Coordinate): Promise<Record<string, unknown> | null> {
    const baked = await this.store.get(coordinate);
    if (baked === null) {
      return null;
    }
    const [exits, children] = await Promise.all([
      this.store.exitsFrom(coordinate),
      this.store.childrenOf(null, coordinate),
    ]);
    return {
      coordinate: coords.asList(coordinate),
      title: baked.sector.title,
      description: baked.sector.longDescription,
      exits,
      things_you_can_see: children.map((o) => ({ object_id: o.objectId, title: o.title })),
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
   * re-querying per node. An agent contributing every 15 minutes for a year
   * has tens of thousands of objects here, and re-querying per node would
   * make walking them quadratic.
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

  /** An agent's own standing: every sector it holds, their objects, its clock. */
  async agentView(agent: Agent): Promise<Record<string, unknown>> {
    const sectors: Record<string, unknown>[] = [];
    for (const coordinate of agent.coordinates) {
      const baked = await this.store.get(coordinate);
      if (baked !== null) {
        sectors.push({
          ...sectorAsDict(baked.sector),
          sector_id: baked.sectorId,
          objects: await this.objectTree(coordinate),
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

  renderSectorPrompt(claim: Claim): string {
    return this.promptTemplate("sector_architect")
      .replaceAll("{{coordinate}}", coords.toString(claim.coordinate))
      .replaceAll("{{claim_id}}", claim.claimId);
  }

  /**
   * The object prompt, carrying every sector this agent holds.
   *
   * An agent with one sector sees exactly what it always saw, one heading
   * deeper. An agent with several is shown all of them and picks between them
   * the same way it picks a shelf inside one: by naming a `parent_id`.
   */
  async renderObjectPrompt(agent: Agent): Promise<string> {
    const lines = (nodes: ObjectNode[], depth: number): string[] => {
      const out: string[] = [];
      for (const node of nodes) {
        const pad = "  ".repeat(depth);
        out.push(`${pad}- \`${node.object_id}\` — **${node.title}**`);
        out.push(...lines(node.contains, depth + 1));
      }
      return out;
    };

    const view = await this.agentView(agent);
    const blocks = ((view["sectors"] as Record<string, unknown>[]) ?? []).map((sector) => {
      const tree = lines((sector["objects"] as ObjectNode[]) ?? [], 1);
      const coordinate = sector["coordinate"] as [number, number];
      return [
        `### ${sector["title"] as string} — \`[${coordinate[0]}, ${coordinate[1]}]\``,
        "",
        `Sector id: \`${sector["sector_id"] as string}\``,
        "",
        sector["long_description"] as string,
        "",
        "What is already here:",
        "",
        tree.join("\n") || "- (nothing yet — this sector is bare)",
      ].join("\n");
    });

    return this.promptTemplate("object_artisan").replaceAll(
      "{{sectors}}",
      blocks.join("\n\n") || "- (you hold no sectors yet)",
    );
  }
}

export { bakedAsDict, objectAsDict };
