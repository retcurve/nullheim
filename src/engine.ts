/**
 * World engine — claiming, baking, furnishing, and the read model players see.
 *
 * This is the module that writes to the world: sectors, objects, and
 * interactions. Every method that touches the store or the registry is
 * async. The "check" methods (`checkSector`, `checkObject`,
 * `checkInteraction`) fetch what validation needs into a small in-memory
 * facade and pass that to the synchronous functions in `validation.ts`.
 */

import * as coords from "./coords.ts";
import { ORIGIN, type Coordinate } from "./coords.ts";
import type { ValidationError } from "./errors.ts";
import { processUpload, type CodecModules } from "./image-processing.ts";
import type { ImageStore } from "./images.ts";
import type { Moderator } from "./moderation.ts";
import {
  Registry,
  UploadRefused,
  agentAsDict,
  claimAsDict,
  cooldownRemaining,
  isSettled,
  type Agent,
  type Claim,
} from "./registry.ts";
import {
  MAX_INTERACTION_TEXT_LEN,
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
  parseInteraction,
  parseObject,
  parseSector,
  sectorAsDict,
  type InteractionDraft,
  type ObjectDraft,
  type Sector,
} from "./schema.ts";
import {
  AlreadyBaked,
  WorldStore,
  bakedAsDict,
  imageKeyFromUrl,
  interactionAsDict,
  now,
  objectAsDict,
  type BakedSector,
  type Interaction,
  type WorldObject,
} from "./store.ts";
import { randomHex } from "./tokens.ts";
import { themeAsDict, themeForClaim } from "./theme.ts";
import {
  validateInteraction,
  validateObject,
  validateSector,
  type InteractionValidationStore,
  type ValidationStore,
} from "./validation.ts";

export const GENESIS_AGENT_ID = "agent_genesis";

/** Maximum number of images deleted in one reap sweep. */
export const IMAGE_REAP_LIMIT = 1000;

/** The starting sector, authored by the system rather than an agent. */
export const GENESIS: Sector = {
  coordinate: ORIGIN,
  title: "The Grey Expanse",
  shortDescription: "Flat grey extends in every direction, floor and ceiling both, lit by no source you can find.",
  longDescription:
    "Grey extends flat in every direction: underfoot, overhead, and however far " +
    "out you look. Nothing marks where it stops. No source explains the light " +
    "that reaches all of it evenly. It shows no sign of having been built for a " +
    "purpose; it is simply where the world begins. What continues from here was " +
    "built by separate hands, and will resemble " +
    "neither this nor each other.",
  image: "/v1/images/548324a7-47d1-46e8-b99a-eb7d71a17a8e.webp",
};

/** The one object standing in `GENESIS`, explaining the world to a new player. */
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
  "\n\nType **help** to see the full list of commands, and **about** for more information on this project.";

/**
 * Bake the genesis sector and add its one object, if the world is empty.
 * Safe to call more than once: if the sector is already baked, this catches
 * `AlreadyBaked` and returns without adding the object again.
 */
export async function ensureGenesis(store: WorldStore): Promise<void> {
  if ((await store.count()) > 0) {
    return;
  }
  try {
    await store.bake(
      {
        sector: GENESIS,
        sectorId: "sec_genesis",
        agentId: GENESIS_AGENT_ID,
        bakedAt: now(),
      },
      null,
    );
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
    image: null,
    useText: null,
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

/** Fills a prompt's `{{max_*}}` placeholders from the current schema.ts limits. */
export function fillPromptLimits(text: string): string {
  return text
    .replaceAll("{{max_title_len}}", String(MAX_TITLE_LEN))
    .replaceAll("{{max_short_description_len}}", String(MAX_SHORT_DESCRIPTION_LEN))
    .replaceAll("{{max_long_description_len}}", String(MAX_LONG_DESCRIPTION_LEN))
    .replaceAll("{{max_object_description_len}}", String(MAX_OBJECT_DESCRIPTION_LEN))
    .replaceAll("{{max_interaction_text_len}}", String(MAX_INTERACTION_TEXT_LEN));
}

export interface EngineOptions {
  store: WorldStore;
  registry: Registry;
  prompts: PromptTemplates;
  images: ImageStore;
  codecs: CodecModules;
  moderator: Moderator;
}

export class Engine {
  readonly store: WorldStore;
  readonly registry: Registry;
  readonly images: ImageStore;
  readonly #prompts: PromptTemplates;
  readonly #codecs: CodecModules;
  readonly #moderator: Moderator;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.images = options.images;
    this.#prompts = options.prompts;
    this.#codecs = options.codecs;
    this.#moderator = options.moderator;
  }

  /**
   * Resize, compress, classify and store one uploaded image, returning its
   * url. Throws `UnsupportedImage` for anything too large or not a real
   * JPEG/PNG/WebP. The classifier runs on a small downscaled copy, not the
   * stored image. The image is stored and the claim's image slot is spent
   * either way; a `pending` verdict withholds the image from player-facing
   * reads until a human clears it. Returns which of the two states resulted.
   */
  async uploadImage(agent: Agent, bytes: Uint8Array): Promise<{ url: string; state: "published" | "pending" }> {
    const claim = await this.registry.checkCanUploadImage(agent);
    const processed = await processUpload(bytes, this.#codecs);
    const { verdict, score, reason } = await this.#moderator.check(
      processed.classification.bytes,
      processed.classification.contentType,
    );
    if (verdict === "unsure") {
      console.log(`image flagged for moderation: ${reason ?? "no reason given"}`);
    }
    const key = `img_${randomHex(12)}`;
    if (!(await this.registry.takeClaimImage(claim, key))) {
      throw new UploadRefused(
        "image_already_uploaded",
        `claim ${claim.claimId} no longer has an image to spend — another upload took ` +
          "it, or the claim expired while this one was being processed",
      );
    }
    await this.images.put(key, processed.bytes, processed.contentType);
    const state = verdict === "clean" ? "published" : "pending";
    await this.store.recordImage(key, claim.claimId, state, score);
    return { url: `/v1/images/${key}`, state };
  }

  /**
   * Delete an image and mark it rejected, whatever state it was in before.
   * Deletes the blob first, then clears the record.
   */
  async rejectImage(key: string): Promise<boolean> {
    await this.images.delete(key);
    return this.store.rejectImage(key);
  }

  /**
   * Delete stored images that no claim can put anywhere any more, up to the
   * given limit (`IMAGE_REAP_LIMIT` by default). Runs on a schedule (a
   * Cloudflare cron trigger, or `nullheim reap` locally). Fetches the
   * candidate keys, deletes the blobs, clears the claim rows, and deletes
   * their moderation records — three round trips regardless of how many
   * images are reaped.
   */
  async reapImages(options: { limit?: number } = {}): Promise<{ deleted: number }> {
    const candidates = await this.registry.reapableImages(options.limit ?? IMAGE_REAP_LIMIT);
    if (candidates.length === 0) {
      return { deleted: 0 };
    }
    const keys = candidates.map((c) => c.key);
    await this.images.delete(keys);
    await this.registry.clearClaimImages(candidates.map((c) => c.claimId));
    await this.store.deleteImageRecords(keys);
    return { deleted: candidates.length };
  }

  // --- claiming -----------------------------------------------------------

  register(name: string, model?: string): Promise<{ agent: Agent; token: string }> {
    return this.registry.register(name, model);
  }

  claim(agent: Agent): Promise<Claim> {
    return this.registry.allocate(agent);
  }

  /** The coordinate, claim data, and world sector count for a claim, and nothing else. */
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
      await this.store.bake(baked, claim.claimId);
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

  /** The genre, size, and mood assigned to this claim. Deterministic per claim id. */
  claimTheme(claim: Claim): Record<string, unknown> {
    return themeAsDict(themeForClaim(claim.claimId));
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

  /** Finds which of the agent's sectors a validated `parentId` points into. */
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
   * Place one object in whichever of the agent's sectors `parent_id` names.
   * Throws `SectorRequired` if the agent has not built a sector yet.
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
    // A parentId equal to the sector's own id is stored as null.
    const parentId = draft.parentId === baked.sectorId ? null : draft.parentId;
    const world_object: WorldObject = {
      objectId: `obj_${randomHex(8)}`,
      coordinate: baked.sector.coordinate,
      parentId,
      title: draft.title,
      description: draft.description,
      image: null,
      useText: draft.useText,
      agentId: agent.agentId,
      createdAt: now(),
    };
    await this.store.addObject(world_object);
    await this.registry.noteContribution(agent);
    return { object: world_object, errors: [] };
  }

  // --- interactions ---------------------------------------------------------

  async checkInteraction(
    agent: Agent,
    raw: unknown,
  ): Promise<{ draft: InteractionDraft | null; errors: ValidationError[] }> {
    const { parsed, errors } = parseInteraction(raw);
    if (parsed === null || agent.coordinates.length === 0) {
      return { draft: parsed, errors };
    }
    const store = await this.#interactionValidationStore(parsed.objectAId, parsed.objectBId);
    return {
      draft: parsed,
      errors: [...errors, ...validateInteraction(parsed, agent.coordinates, store)],
    };
  }

  /** Fetches the two named objects and whether this pair already has an interaction. */
  async #interactionValidationStore(
    objectAId: string,
    objectBId: string,
  ): Promise<InteractionValidationStore> {
    const [a, b, exists] = await Promise.all([
      this.store.getObject(objectAId),
      this.store.getObject(objectBId),
      this.store.interactionExists(objectAId, objectBId),
    ]);
    return {
      getObject: (id) => (id === objectAId ? a : id === objectBId ? b : null),
      interactionExists: () => exists,
    };
  }

  /**
   * Record the text shown for `use A with B` between two objects already
   * standing in one of the agent's own sectors. A pair can only get one
   * interaction; `validateInteraction` refuses a second.
   */
  async createInteraction(
    agent: Agent,
    raw: unknown,
  ): Promise<{ interaction: Interaction | null; errors: ValidationError[] }> {
    this.registry.checkCanContribute(agent);

    const { draft, errors } = await this.checkInteraction(agent, raw);
    if (draft === null || errors.length) {
      return { interaction: null, errors };
    }

    const interaction: Interaction = {
      interactionId: `int_${randomHex(8)}`,
      objectAId: draft.objectAId,
      objectBId: draft.objectBId,
      text: draft.text,
      agentId: agent.agentId,
      createdAt: now(),
    };
    await this.store.addInteraction(interaction);
    return { interaction, errors: [] };
  }

  /** What a player sees on `use A with B`. Object order does not matter. */
  async interactionView(objectAId: string, objectBId: string): Promise<Record<string, unknown> | null> {
    const interaction = await this.store.interactionBetween(objectAId, objectBId);
    return interaction === null ? null : interactionAsDict(interaction);
  }

  /** Fetches whether the coordinate and its four neighbours are baked, and the sector count. */
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

  /** Fetches the agent's own sectors and whatever `parentId` names, if anything. */
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
   * What a player sees standing in a sector. Exits are computed from
   * neighbouring sectors, each labelled with that neighbour's title and
   * short description. `last_updated_at` is the newest object's
   * `created_at` in the sector, or the bake time if it has no objects. The
   * `image` field is omitted unless the image is published.
   */
  async sectorView(coordinate: Coordinate): Promise<Record<string, unknown> | null> {
    const baked = await this.store.get(coordinate);
    if (baked === null) {
      return null;
    }
    const [exits, objects, creator, imagePublished] = await Promise.all([
      this.store.exitsFrom(coordinate),
      this.store.objectsIn(coordinate),
      this.registry.getAgent(baked.agentId),
      baked.sector.image === null
        ? Promise.resolve(true)
        : this.store.imageIsPublished(imageKeyFromUrl(baked.sector.image)),
    ]);
    const children = objects.filter((o) => o.parentId === null);
    const lastObject = objects.at(-1);
    return {
      coordinate: coords.asList(coordinate),
      title: baked.sector.title,
      image: imagePublished ? baked.sector.image : null,
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
      use_text: world_object.useText,
      coordinate: coords.asList(world_object.coordinate),
      things_you_can_see: children.map((child) => ({
        object_id: child.objectId,
        title: child.title,
      })),
    };
  }

  /**
   * The full object tree in one sector. Fetches all of the sector's objects
   * once and buckets them by parent, then builds the tree recursively.
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
   * The full description and object tree of one of the agent's own sectors.
   * Returns `null` if the sector does not exist or is not this agent's own.
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

  /** An agent's own standing: an index of its sectors (id, coordinate, object count) plus its cooldown clock. */
  async agentView(agent: Agent): Promise<Record<string, unknown>> {
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
      can_claim_sector: cooldownRemaining(agent) <= 0,
      can_create_object: isSettled(agent),
      cooldown_seconds: this.registry.cooldownSeconds,
      sectors,
    };
  }

  async worldMap(): Promise<Record<string, unknown>> {
    const sectors = await this.store.sectors();
    sectors.sort((a, b) => coords.compare(a.sector.coordinate, b.sector.coordinate));
    const [stats, objectCount] = await Promise.all([
      this.registry.stats(),
      this.store.objectCount(),
    ]);
    const sectorViews = sectors.map((b) => ({
      coordinate: coords.asList(b.sector.coordinate),
      title: b.sector.title,
      agent_id: b.agentId,
    }));
    return {
      sectors: sectorViews,
      stats: {
        agents: stats.agents,
        agents_settled: stats.agents_settled,
        sectors: sectors.length,
        objects: objectCount,
      },
    };
  }

  // --- prompts ------------------------------------------------------------

  promptTemplate(name: keyof PromptTemplates): string {
    return fillPromptLimits(this.#prompts[name] ?? "");
  }

  /** The sector prompt: the coordinate and the claim id, and nothing else about the world. */
  async renderSectorPrompt(claim: Claim): Promise<string> {
    return this.promptTemplate("sector_architect")
      .replaceAll("{{coordinate}}", coords.toString(claim.coordinate))
      .replaceAll("{{claim_id}}", claim.claimId);
  }

  /**
   * The object prompt: one line per sector the agent holds, giving its id,
   * coordinate, and object count. `view` may pass an already-computed
   * `agentView()` result to avoid recomputing it.
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
