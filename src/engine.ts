/**
 * World engine — claiming, baking, furnishing, and the read model players see.
 *
 * This is the only module that mutates the world, and it is where the static
 * lock lives: once a sector bakes it is permanent, and once an object is placed
 * it stays placed. What is no longer permanent is the agent — it keeps its token
 * and comes back every eight hours to add one more thing.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as coords from "./coords.ts";
import { ORIGIN, type Coordinate } from "./coords.ts";
import type { ValidationError } from "./errors.ts";
import {
  Registry,
  agentAsDict,
  claimAsDict,
  cooldownRemaining,
  isSettled,
  type Agent,
  type Claim,
  type RegistryOptions,
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
import { validateObject, validateSector } from "./validation.ts";

const PROMPT_DIR = join(import.meta.dirname, "..", "prompts");

export const GENESIS_AGENT_ID = "agent_genesis";

/**
 * The one sector the system authors. It exists only to give the frontier
 * somewhere to start, and its text is deliberately blank-canvas so it imposes no
 * theme on the agents who build outward from it.
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

export interface ObjectNode {
  object_id: string;
  title: string;
  description: string;
  contains: ObjectNode[];
}

export interface EngineOptions extends RegistryOptions {
  store?: WorldStore;
  registry?: Registry;
  statePath?: string | null;
}

export class Engine {
  readonly store: WorldStore;
  readonly registry: Registry;

  constructor(options: EngineOptions = {}) {
    this.store = options.store ?? new WorldStore(options.statePath ?? null);
    if (options.registry !== undefined) {
      this.registry = options.registry;
    } else {
      const registryOptions: RegistryOptions = {};
      if (options.leaseSeconds !== undefined) {
        registryOptions.leaseSeconds = options.leaseSeconds;
      }
      if (options.cooldownSeconds !== undefined) {
        registryOptions.cooldownSeconds = options.cooldownSeconds;
      }
      if (options.rng !== undefined) {
        registryOptions.rng = options.rng;
      }
      this.registry = new Registry(this.store, registryOptions);
    }
    this.#ensureGenesis();
  }

  #ensureGenesis(): void {
    if (this.store.count() === 0) {
      this.store.bake({
        sector: GENESIS,
        sectorId: "sec_genesis",
        agentId: GENESIS_AGENT_ID,
        bakedAt: now(),
      });
    }
  }

  // --- claiming -----------------------------------------------------------

  register(label: string): { agent: Agent; token: string } {
    return this.registry.register(label);
  }

  claim(agent: Agent): Claim {
    return this.registry.allocate(agent);
  }

  /**
   * Everything an agent is told about its sector before authoring it.
   *
   * Which is: where it is, and how long it has. Nothing about what stands on any
   * side of it — not a title, not a doorway, not even how many neighbours exist.
   * An agent that knows nothing cannot hedge toward its neighbours, and the
   * tonal collision between adjacent sectors is the whole reason players walk
   * around.
   */
  claimContext(claim: Claim): Record<string, unknown> {
    return {
      claim: claimAsDict(claim),
      coordinate: coords.asList(claim.coordinate),
      world_sectors: this.store.count(),
    };
  }

  // --- sector submission --------------------------------------------------

  /** Parse and validate without touching the world — the dry-run path. */
  checkSector(claim: Claim, raw: unknown): { sector: Sector | null; errors: ValidationError[] } {
    const { parsed, errors } = parseSector(raw);
    if (parsed === null) {
      return { sector: null, errors };
    }
    return {
      sector: parsed,
      errors: [...errors, ...validateSector(parsed, claim.coordinate, this.#validationStore())],
    };
  }

  /** Validate and, if clean, bake permanently and start the agent's clock. */
  submitSector(
    agent: Agent,
    claim: Claim,
    raw: unknown,
  ): { baked: BakedSector | null; errors: ValidationError[] } {
    this.registry.noteAttempt(claim);
    const { sector, errors } = this.checkSector(claim, raw);
    if (sector === null || errors.length) {
      return { baked: null, errors };
    }

    const baked: BakedSector = {
      sector,
      sectorId: `sec_${randomBytes(8).toString("hex")}`,
      agentId: agent.agentId,
      bakedAt: now(),
    };
    try {
      this.store.bake(baked);
    } catch (exc) {
      if (exc instanceof AlreadyBaked) {
        return {
          baked: null,
          errors: [{ code: "already_baked", path: "$.coordinate", message: exc.message }],
        };
      }
      throw exc;
    }

    this.registry.settle(agent, claim);
    return { baked, errors: [] };
  }

  release(claim: Claim): void {
    this.registry.release(claim);
  }

  // --- objects ------------------------------------------------------------

  checkObject(
    agent: Agent,
    raw: unknown,
  ): { draft: ObjectDraft | null; errors: ValidationError[] } {
    const { parsed, errors } = parseObject(raw);
    if (parsed === null || agent.coordinate === null) {
      return { draft: parsed, errors };
    }
    return {
      draft: parsed,
      errors: [
        ...errors,
        ...validateObject(parsed, agent.coordinate, this.#validationStore()),
      ],
    };
  }

  /**
   * Place one object.
   *
   * Throws SectorRequired if the agent has not built one yet, NotYet if its
   * cooldown is still running.
   */
  createObject(
    agent: Agent,
    raw: unknown,
  ): { object: WorldObject | null; errors: ValidationError[] } {
    this.registry.checkCanContribute(agent);

    const { draft, errors } = this.checkObject(agent, raw);
    if (draft === null || errors.length) {
      return { object: null, errors };
    }

    // Both guaranteed by checkCanContribute.
    const coordinate = agent.coordinate!;
    const baked = this.store.get(coordinate)!;
    // Internally the sector itself is still represented as parentId=null — the
    // sector's own id is only the agent-facing spelling of "the root".
    const parentId = draft.parentId === baked.sectorId ? null : draft.parentId;
    const world_object: WorldObject = {
      objectId: `obj_${randomBytes(8).toString("hex")}`,
      coordinate,
      parentId,
      title: draft.title,
      description: draft.description,
      agentId: agent.agentId,
      createdAt: now(),
    };
    this.store.addObject(world_object);
    this.registry.noteContribution(agent);
    return { object: world_object, errors: [] };
  }

  /** The narrow view validation is allowed to ask questions through. */
  #validationStore() {
    return {
      get: (coordinate: Coordinate) => this.store.get(coordinate),
      getObject: (objectId: string) => this.store.getObject(objectId),
      isBaked: (coordinate: Coordinate) => this.store.isBaked(coordinate),
      count: () => this.store.count(),
    };
  }

  // --- the read model players see -----------------------------------------

  /**
   * What a player sees standing in a sector.
   *
   * Exits are computed here, not stored. Each one is labelled with the
   * neighbour's own title and, on closer examination, its short description.
   */
  sectorView(coordinate: Coordinate): Record<string, unknown> | null {
    const baked = this.store.get(coordinate);
    if (baked === null) {
      return null;
    }
    return {
      coordinate: coords.asList(coordinate),
      title: baked.sector.title,
      description: baked.sector.longDescription,
      exits: this.store.exitsFrom(coordinate),
      things_you_can_see: this.store.childrenOf(null, coordinate).map((o) => ({
        object_id: o.objectId,
        title: o.title,
      })),
    };
  }

  /** What a player sees on looking at an object, including what is on it. */
  objectView(objectId: string): Record<string, unknown> | null {
    const world_object = this.store.getObject(objectId);
    if (world_object === null) {
      return null;
    }
    return {
      object_id: world_object.objectId,
      title: world_object.title,
      description: world_object.description,
      coordinate: coords.asList(world_object.coordinate),
      things_you_can_see: this.store
        .childrenOf(objectId, world_object.coordinate)
        .map((child) => ({ object_id: child.objectId, title: child.title })),
    };
  }

  /**
   * The full object tree in one sector — what its own author may see.
   *
   * The sector's objects are fetched once and bucketed by parent, rather than
   * re-querying per node. An agent contributing every eight hours for a year has
   * around a thousand objects here, and the old shape made walking them
   * quadratic.
   */
  objectTree(coordinate: Coordinate): ObjectNode[] {
    const byParent = new Map<string | null, WorldObject[]>();
    for (const world_object of this.store.objectsIn(coordinate)) {
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

  /** An agent's own standing: its sector, its objects, and its clock. */
  agentView(agent: Agent): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      agent: agentAsDict(agent),
      can_claim_sector: !isSettled(agent),
      can_create_object: isSettled(agent) && cooldownRemaining(agent) <= 0,
      cooldown_seconds: this.registry.cooldownSeconds,
      sector: null,
    };
    if (agent.coordinate !== null) {
      const baked = this.store.get(agent.coordinate);
      if (baked !== null) {
        payload["sector"] = {
          ...sectorAsDict(baked.sector),
          sector_id: baked.sectorId,
          objects: this.objectTree(agent.coordinate),
        };
      }
    }
    return payload;
  }

  worldMap(): Record<string, unknown> {
    const sectors = this.store.sectors();
    sectors.sort((a, b) => coords.compare(a.sector.coordinate, b.sector.coordinate));
    return {
      sectors: sectors.map((b) => ({
        coordinate: coords.asList(b.sector.coordinate),
        title: b.sector.title,
        agent_id: b.agentId,
        exits: this.store.exitsFrom(b.sector.coordinate).map((e) => e.direction),
        objects: this.store.objectsIn(b.sector.coordinate).length,
      })),
      edges: this.store.edges(),
      frontier: this.registry.frontier().map(coords.asList),
      stats: {
        ...this.registry.stats(),
        sectors: this.store.count(),
        objects: this.store.objectCount(),
      },
    };
  }

  // --- prompts ------------------------------------------------------------

  promptTemplate(name: string): string {
    try {
      return readFileSync(join(PROMPT_DIR, `${name}.md`), "utf-8");
    } catch {
      return ""; // packaging safety net
    }
  }

  renderSectorPrompt(claim: Claim): string {
    return this.promptTemplate("sector_architect")
      .replaceAll("{{coordinate}}", coords.toString(claim.coordinate))
      .replaceAll("{{claim_id}}", claim.claimId);
  }

  renderObjectPrompt(agent: Agent): string {
    const view = this.agentView(agent);
    const sector = (view["sector"] ?? {}) as Record<string, unknown>;

    const lines = (nodes: ObjectNode[], depth = 0): string[] => {
      const out: string[] = [];
      for (const node of nodes) {
        const pad = "  ".repeat(depth);
        out.push(`${pad}- \`${node.object_id}\` — **${node.title}**`);
        out.push(...lines(node.contains, depth + 1));
      }
      return out;
    };

    const tree = lines((sector["objects"] as ObjectNode[]) ?? []);
    return this.promptTemplate("object_artisan")
      .replaceAll("{{coordinate}}", coords.toString(agent.coordinate!))
      .replaceAll("{{sector_id}}", (sector["sector_id"] as string) ?? "")
      .replaceAll("{{sector_title}}", (sector["title"] as string) ?? "")
      .replaceAll("{{sector_description}}", (sector["long_description"] as string) ?? "")
      .replaceAll(
        "{{existing_objects}}",
        tree.join("\n") || "- (nothing yet — this sector is bare)",
      );
  }
}

export { bakedAsDict, objectAsDict };
