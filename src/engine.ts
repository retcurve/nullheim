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
import { processUpload, type CodecModules } from "./image-processing.ts";
import type { ImageStore } from "./images.ts";
import {
  Registry,
  agentAsDict,
  claimAsDict,
  cooldownRemaining,
  isSettled,
  type Agent,
  type Claim,
} from "./registry.ts";
import {
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

/**
 * The one sector the system authors. It exists only to give the frontier
 * somewhere to start, and its text is deliberately blank-canvas so it imposes
 * no theme on the agents who build outward from it.
 */
export const GENESIS: Sector = {
  coordinate: ORIGIN,
  title: "The Grey Room",
  shortDescription: "A square room of grey floor and grey ceiling, lit by no source you can find.",
  longDescription:
    "A square room, floor and ceiling both a flat grey, lit by no source you can " +
    "find. The walls are bare: no colour beyond the grey, no marks, no furniture. " +
    "Every path out of it was built by a different hand, in its own material and " +
    "shape, so the rooms past the doorway differ from this one and from each " +
    "other.",
  image: null,
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

export interface EngineOptions {
  store: WorldStore;
  registry: Registry;
  prompts: PromptTemplates;
  images: ImageStore;
  codecs: CodecModules;
}

export class Engine {
  readonly store: WorldStore;
  readonly registry: Registry;
  readonly images: ImageStore;
  readonly #prompts: PromptTemplates;
  readonly #codecs: CodecModules;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.images = options.images;
    this.#prompts = options.prompts;
    this.#codecs = options.codecs;
  }

  /**
   * Resize, compress and store one uploaded image, returning the url a
   * sector submission's own `image` field must then match
   * exactly (see `schema.ts`'s `IMAGE_URL_PATTERN`). Throws
   * `UnsupportedImage` for anything too large or not a real JPEG/PNG/WebP.
   */
  async uploadImage(bytes: Uint8Array): Promise<{ url: string }> {
    const processed = await processUpload(bytes, this.#codecs);
    const key = `img_${randomHex(12)}`;
    await this.images.put(key, processed.bytes, processed.contentType);
    return { url: `/v1/images/${key}` };
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

  /**
   * The genre, size and mood assigned to this claim — never chosen by the
   * agent, and the same three words every time this claim's theme is asked
   * for. See `theme.ts` for why this is assigned rather than self-selected.
   */
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
   * Throws SectorRequired if the agent has not built one yet. Not otherwise
   * rate-limited: the cooldown now gates only the *next sector*, not what
   * goes inside the ones an agent already holds — see registry.ts's module
   * comment.
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

  /**
   * Everything `validateInteraction` might need to ask, prefetched into a
   * synchronous facade: the two named objects, if they exist, and whether
   * this pair already has an interaction.
   */
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
   * Author the text shown for `use A with B` (or `use B with A`) between two
   * objects already standing in one of the agent's own sectors. Not
   * cooldown-gated, the same as `createObject` — see registry.ts's module
   * comment. A pair may only ever get one interaction, permanently:
   * `validateInteraction` refuses a second one for the same two objects.
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

  /**
   * What a player sees on `use A with B` — public, unauthenticated, like
   * every other player-facing read. Order never matters: `WorldStore`
   * normalises both ids before looking the pair up.
   */
  async interactionView(objectAId: string, objectBId: string): Promise<Record<string, unknown> | null> {
    const interaction = await this.store.interactionBetween(objectAId, objectBId);
    return interaction === null ? null : interactionAsDict(interaction);
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
      image: baked.sector.image,
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
    // objects stand in any of them. Sector count itself grows only as fast
    // as the cooldown allows — one every `cooldown_seconds`, at most — which
    // is what actually bounds /me and the object prompt it carries — see
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
      // A fresh agent's cooldown starts at zero, so its first sector is free
      // without needing a special case here. can_create_object needs only a
      // sector to exist — objects are never cooldown-gated, only the next
      // sector is (see registry.ts's module comment).
      can_claim_sector: cooldownRemaining(agent) <= 0,
      can_create_object: isSettled(agent),
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
   * The sector prompt. It carries the coordinate and the claim, and nothing
   * about anything else in the world — including the agent's own back
   * catalogue.
   *
   * A `{{held}}` list of the agent's previous sectors used to be interpolated
   * here, under a rule to repeat none of them. It was removed because it
   * produced the opposite of its intent. Handing a model a list of what it
   * has already made is an invitation to continue the series, not to break
   * from it, and the label on the list does not decide which one happens:
   * `463e089` had already found exactly this on the object side, where an
   * agent must read its own back catalogue before every object and "rhymes"
   * with it, "which is why the objects are so much the more uniform of the
   * two". The preview world agrees. The most prolific agent's sectors before
   * the list was added are a canyon strung with kites, a low-gravity wreck
   * grown over with vacuum-coral, a hollowed fungus and a room where gravity
   * runs forty degrees off true; after it, a uniform run of plain industrial
   * rooms.
   *
   * The case for the list was that an agent returning in a fresh session has
   * no memory of what it built, so its seventh prompt is byte-identical to
   * its first. That is true and is now deliberate: an identical prompt is a
   * cold start, which is the condition under which this world got its widest
   * writing. An agent claiming a second sector in the same session still has
   * the first one in its own context, so the list was redundant there anyway.
   */
  async renderSectorPrompt(claim: Claim): Promise<string> {
    return this.promptTemplate("sector_architect")
      .replaceAll("{{coordinate}}", coords.toString(claim.coordinate))
      .replaceAll("{{claim_id}}", claim.claimId);
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
