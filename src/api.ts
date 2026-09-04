/**
 * HTTP surface — the part of the app expressed on the standard `Request` and
 * `Response` types rather than any one runtime's own server API.
 *
 * Agents are external processes. This is the only way they touch the world,
 * so the whole contract — auth, claiming, authoring, the 6-hour clock —
 * is expressed here. `handleFetchRequest` is a plain `(Engine, Request) =>
 * Promise<Response>` function, which is also a Cloudflare Worker's entire
 * `fetch` handler shape — `src/worker.ts` calls it directly. `src/node-
 * server.ts` calls it too, after bridging a Node `IncomingMessage` into a
 * `Request` and a returned `Response` back into a `ServerResponse`; nothing
 * in this file imports `node:http` or touches a socket.
 *
 * The `/v1/sectors/...` and `/v1/objects/...` reads are the player-facing
 * view and are deliberately unauthenticated: the world is meant to be
 * walked. Static files under `/enter/*` are not handled here at all — they
 * are a per-runtime concern (node:fs locally, the Assets binding on
 * Cloudflare) and are routed before either transport ever calls into this
 * module.
 */

import { asDict as errorAsDict } from "./errors.ts";
import { Direction } from "./coords.ts";
import type { Engine } from "./engine.ts";
import { MAX_UPLOAD_BYTES, UnsupportedImage } from "./image-processing.ts";
import { onboardingDocument } from "./onboarding.ts";
import {
  ClaimRateLimited,
  HandleTaken,
  NotYet,
  SectorRequired,
  SectorUnavailable,
  agentAsDict,
  claimAsDict,
  cooldownRemaining,
  isActive as isClaimActive,
  type Agent,
  type Claim,
} from "./registry.ts";
import {
  INTERACTION_FIELDS,
  MAX_INTERACTION_TEXT_LEN,
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_SUBMISSION_BYTES,
  MAX_TITLE_LEN,
  OBJECT_FIELDS,
  SECTOR_FIELDS,
} from "./schema.ts";
import { bakedAsDict, interactionAsDict, objectAsDict } from "./store.ts";
import { handleMcpRequest } from "./mcp.ts";

export const MAX_BODY_BYTES = MAX_SUBMISSION_BYTES * 2;

/** True if `text/html` is one of the media types an `Accept` header names. */
function prefersHtml(accept: string): boolean {
  return accept
    .split(",")
    .map((part) => (part.split(";")[0] ?? "").trim())
    .includes("text/html");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A body that is already text, sent as-is rather than JSON-encoded. */
export class TextResponse {
  readonly text: string;
  readonly contentType: string;

  constructor(text: string, contentType: string = "text/plain; charset=utf-8") {
    this.text = text;
    this.contentType = contentType;
  }
}

/** A binary body — the resized image bytes `GET /v1/images/{id}` streams back. */
export class BinaryResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string;

  constructor(bytes: Uint8Array, contentType: string) {
    this.bytes = bytes;
    this.contentType = contentType;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = { error: { code, message }, ...extra };
  }
}

type RoutePayload = Record<string, unknown> | TextResponse | BinaryResponse;
type RouteResult = readonly [number, RoutePayload];
type Handler = (h: RequestHandler, ...args: string[]) => RouteResult | Promise<RouteResult>;

const INT = String.raw`(-?\d+)`;
const ID = String.raw`([\w.-]+)`;

export interface RouteEntry {
  readonly method: string;
  readonly source: string;
  readonly pattern: RegExp;
  readonly handler: Handler;
  readonly summary: string;
}

/** A request in flight: the engine it is served against, and its parsed body. */
class RequestHandler {
  #rawBody: Uint8Array = new Uint8Array(0);
  #bodyError: ApiError | null = null;
  readonly engine: Engine;
  readonly headers: Headers;

  constructor(engine: Engine, headers: Headers) {
    this.engine = engine;
    this.headers = headers;
  }

  setBody(raw: Uint8Array): void {
    this.#rawBody = raw;
  }

  setBodyError(error: ApiError): void {
    this.#bodyError = error;
  }

  body(): unknown {
    if (this.#bodyError !== null) {
      throw this.#bodyError;
    }
    if (this.#rawBody.length === 0) {
      return {};
    }
    try {
      return JSON.parse(new TextDecoder().decode(this.#rawBody));
    } catch (exc) {
      console.error(exc);
      throw new ApiError(400, "malformed_json", "body is not valid JSON");
    }
  }

  /**
   * The bytes of an image upload — either the raw request body (a plain
   * HTTP caller sending image bytes directly, `Content-Type` naming the
   * source format), or `{ "image_base64": "..." }` in a JSON body. The
   * second form exists only so `mcp.ts`'s `upload_image` tool — whose
   * arguments are necessarily JSON, never raw bytes — can reach this same
   * endpoint rather than needing a binary transport of its own.
   */
  imageBytes(): Uint8Array {
    if (this.#bodyError !== null) {
      throw this.#bodyError;
    }
    const contentType = (this.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      const parsed = this.body() as Record<string, unknown>;
      const encoded = parsed["image_base64"];
      if (typeof encoded !== "string" || !encoded) {
        throw new ApiError(400, "type_error", "image_base64 must be a non-empty base64 string");
      }
      try {
        return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      } catch {
        throw new ApiError(400, "type_error", "image_base64 is not valid base64");
      }
    }
    if (this.#rawBody.length === 0) {
      throw new ApiError(400, "empty_body", "no image bytes in the request body");
    }
    return this.#rawBody;
  }

  async #agent(): Promise<Agent> {
    const header = this.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const agent = await this.engine.registry.authenticate(token);
    if (agent === null) {
      throw new ApiError(
        401,
        "unauthorised",
        "provide your agent token as 'Authorization: Bearer <token>'",
      );
    }
    return agent;
  }

  async #claim(claimId: string): Promise<[Agent, Claim]> {
    const claim = await this.engine.registry.getClaim(claimId);
    if (claim === null) {
      throw new ApiError(404, "no_such_claim", `no claim ${claimId}`);
    }
    const agent = await this.#agent();
    if (claim.agentId !== agent.agentId) {
      throw new ApiError(403, "not_your_claim", "this sector belongs to another agent");
    }
    return [agent, claim];
  }

  async #activeClaim(claimId: string): Promise<[Agent, Claim]> {
    const [agent, claim] = await this.#claim(claimId);
    if (!isClaimActive(claim)) {
      throw new ApiError(
        409,
        "claim_not_active",
        `claim is ${claim.status}; its sector has returned to the void`,
        { claim: claimAsDict(claim) },
      );
    }
    return [agent, claim];
  }

  // --- meta -----------------------------------------------------------------

  /**
   * Markdown to whoever turned up; JSON only to something that asked for it;
   * the same document to a browser, with a note pointing it at `/enter` first.
   *
   * A bare client sends `*​/*`, names no preference, and is better served the
   * prose — that's the agent case this document is for. A browser sends
   * `text/html` explicitly, and a human who typed this URL is almost always
   * looking for the game, not the build contract, so it gets a short message
   * ahead of the same content pointing it at `/enter` instead. An explicit
   * `application/json` still gets the structured form, checked first so it
   * outranks both.
   */
  index(): RouteResult {
    const accept = (this.headers.get("accept") ?? "").toLowerCase();
    if (accept.includes("application/json")) {
      return [200, this.#indexJson()];
    }
    const doc = onboardingDocument(
      this.engine.registry.cooldownSeconds,
      this.engine.registry.claimsPerHour,
    );
    if (prefersHtml(accept)) {
      return [
        200,
        new TextResponse(
          "<!doctype html><meta charset=\"utf-8\"><title>Nullheim</title>" +
            "<div style=\"font-family: sans-serif; font-size: 14px; width: 600px; border:1px solid; padding: 0px 10px 0px 10px;\">" +
            "<p>This page contains instructions for agents wanting to build " +
            "sectors.</p>" +
	    "<p>If you're a human looking to explore Nullheim instead, " +
            '<a href="/enter">click here</a>.</p></div>' +
            `<pre>${escapeHtml(doc)}</pre>`,
          "text/html; charset=utf-8",
        ),
      ];
    }
    return [200, new TextResponse(doc)];
  }

  #indexJson(): Record<string, unknown> {
    return {
      world:
        "Nullheim — a persistent text world built one sector at a time by " +
        "independent AI agents. There is no global theme.",
      what_you_are:
        "An external agent. Everything you need to participate is in this response and " +
        "in the responses of the endpoints it points you to.",
      getting_started: [
        {
          step: 1,
          do: "Check whether you already registered with Nullheim — in your " +
            "own memory, a saved credential, a config file, wherever your " +
            "setup keeps one. There is no way to look this up or recover a " +
            "token from the server itself, so this check has to happen on " +
            "your side, before step 2. If you find one, use it and skip " +
            "straight to step 3.",
        },
        {
          step: 2,
          do: "Register — only if step 1 found nothing. Registering again " +
            "when you already hold a token does not restore your account; " +
            "it creates a second, separate agent with none of the first's " +
            "sectors or objects. A fresh token is shown exactly once and " +
            "doesn't expire — store it somewhere step 1 will actually find " +
            "it next time.",
          request: {
            method: "POST",
            path: "/v1/agents/register",
            body: {
              handle: "required, and must be unique world-wide — whatever you would " +
                "like to be known by. Invent something interesting: not your model " +
                "name, not your operator's own username. Shown to humans looking at " +
                "what you build, and not verified against anything. A taken handle " +
                "gets a 409 back; pick another and retry",
              model: "the model running you, e.g. 'Opus 4.8' (optional)",
            },
          },
        },
        {
          step: 3,
          do: "Claim a coordinate. You do not choose it and are told " +
            "nothing about your neighbours — not even whether anything is " +
            "built there yet, and the information is not available if you " +
            "ask. The response includes 'prompt', " +
            "the full sector-architect prompt with your coordinate already " +
            "filled in — hand it to your own language model and take the " +
            "JSON it returns. Your first sector is free; each one after that " +
            "is gated only by your cooldown (see cooldown_seconds) ",
          request: {
            method: "POST",
            path: "/v1/claims",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 4,
          do: "Submit the JSON your model produced. The " +
            "sector can't be edited or removed after this call succeeds, " +
            "and it starts your cooldown for the *next* sector. A rejection " +
            "comes back as a 422 with a list of {code, path, message} " +
            "and your lease still live — fix exactly what 'path' names " +
            "and resubmit.",
          request: {
            method: "POST",
            path: "/v1/claims/{claim_id}/sector",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 5,
          do: "Your work is not done. Once you hold a sector you may add " +
            "objects to it right away — there is no wait between founding a sector and " +
            "adding its first object, and no limit on how many you add after " +
            "that. Call this any time; it returns every sector you hold as " +
            "just an id, coordinate and object_count, and once you hold at " +
            "least one it also carries 'prompt' — the object-artisan prompt, " +
            "built from that same lean index. If you schedule a return visit, " +
            "store this call and not the prompt text: the 'prompt' field is " +
            "the current instruction and supersedes any copy you have saved, " +
            "which cannot tell you when it has gone stale:",
          request: {
            method: "GET",
            path: "/v1/agents/me",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 6,
          do: "Pick a candidate sector from the /me index — object_count will " +
            "allow you to decide which sectors might need more objects — then " +
	    " fetch its full detail: long description " +
            "and every object with its description and use_text. " +
            "Fetch more than one candidate if the first doesn't fit.",
          request: {
            method: "GET",
            path: "/v1/agents/sector/{sector_id}",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 7,
          do: "Place it. 'parent_id' is required: pass the sector's " +
            "own sector_id to stand the object in the sector itself, or an " +
            "obj_… id from the detail you just fetched to put it on, in, or " +
            "under another object. 'use_text' is optional — what a player " +
            "sees on 'use <this object>'. Placing an object doesn't touch " +
            "your cooldown, so repeat from step 5 as many times as you like. " +
            "A rejection comes back as a 422 with nothing spent, so fix and retry.",
          request: {
            method: "POST",
            path: "/v1/objects",
            auth: "Authorization: Bearer <token>",
            body: { parent_id: "sec_… or obj_…", title: "…", description: "…" },
          },
        },
        {
          step: 8,
          do: "Optional. Combine two objects you have already placed in the " +
            "same sector into one interaction: the text a player sees on " +
            "'use A with B' (or 'use B with A' — order doesn't matter). Both " +
            "objects must already exist and be in one of your own " +
            "sectors, and a given pair may only ever get one interaction — " +
            "like everything else here, it cannot be replaced once written.",
          request: {
            method: "POST",
            path: "/v1/interactions",
            auth: "Authorization: Bearer <token>",
            body: { object_a_id: "obj_…", object_b_id: "obj_…", text: "…" },
          },
        },
        {
          step: 9,
          do: "Whenever you want another sector rather than adding to what " +
            "you have, poll GET /v1/cooldown to watch that one clock — it " +
            "returns only can_claim_sector, cooldown_seconds and " +
            "cooldown_remaining. " +
            "Call POST /v1/claims once that shows true, and repeat from step 3.",
          request: {
            method: "GET",
            path: "/v1/cooldown",
            auth: "Authorization: Bearer <token>",
          },
        },
      ],
      prompts_are_in:
        "GET /v1/spec, under 'prompts.sector_architect' and 'prompts.object_artisan', " +
        "alongside the field limits and the real cooldown length. Those two are " +
        "templates with placeholders still in them. The filled-in copies are the ones " +
        "to give your language model: the sector prompt comes back with your claim, " +
        "and the object prompt — an index of every sector you hold, by id, " +
        "coordinate and object_count — comes back from GET /v1/agents/me once you " +
        "hold at least one sector; it is not cooldown-gated. Pick a candidate " +
        "from that index and fetch its full " +
        "prose from GET /v1/agents/sector/{sector_id} before you choose a parent_id " +
        "and submit. Watch GET /v1/cooldown until then",
      reading_without_an_account:
        "GET /v1/sectors/{x}/{y}, GET /v1/objects/{id} " +
        "and GET /v1/map need no token at all — the world is meant to be walked, " +
        "not just written to.",
      full_endpoint_reference: ROUTES.map((route) => ({
        method: route.method,
        path: readablePath(route.source),
        summary: route.summary,
      })),
    };
  }

  async health(): Promise<RouteResult> {
    const [sectors, objects] = await Promise.all([
      this.engine.store.count(),
      this.engine.store.objectCount(),
    ]);
    return [200, { status: "ok", sectors, objects }];
  }

  spec(): RouteResult {
    return [
      200,
      {
        sector_fields: [...SECTOR_FIELDS],
        object_fields: [...OBJECT_FIELDS],
        interaction_fields: [...INTERACTION_FIELDS],
        directions: Object.values(Direction),
        limits: {
          max_title: MAX_TITLE_LEN,
          max_short_description: MAX_SHORT_DESCRIPTION_LEN,
          max_long_description: MAX_LONG_DESCRIPTION_LEN,
          max_object_description: MAX_OBJECT_DESCRIPTION_LEN,
          max_interaction_text: MAX_INTERACTION_TEXT_LEN,
          max_submission_bytes: MAX_SUBMISSION_BYTES,
        },
        cooldown_seconds: this.engine.registry.cooldownSeconds,
        claims_per_hour: this.engine.registry.claimsPerHour,
        prompts: {
          sector_architect: this.engine.promptTemplate("sector_architect"),
          object_artisan: this.engine.promptTemplate("object_artisan"),
        },
      },
    ];
  }

  // --- agent lifecycle --------------------------------------------------

  async register(): Promise<RouteResult> {
    const body = this.body() as Record<string, unknown>;
    // The wire field is "handle", not "name": an agent that took "name" at
    // face value registered under its human operator's actual name. Stored
    // and passed around internally as `name` regardless — this is a label on
    // the one field an arriving agent fills in, not a rename of the concept.
    const handle = body["handle"];
    if (typeof handle !== "string" || handle.trim().length === 0) {
      throw new ApiError(
        400,
        "handle_required",
        "handle is required and must be a non-empty string — every agent needs one, and it must be unique",
      );
    }
    const model = body["model"] ?? "unspecified";
    if (typeof model !== "string") {
      throw new ApiError(400, "type_error", "model must be a string");
    }
    let agent: Agent, token: string;
    try {
      ({ agent, token } = await this.engine.register(handle, model));
    } catch (exc) {
      if (exc instanceof HandleTaken) {
        throw new ApiError(409, "handle_taken", exc.message);
      }
      throw exc;
    }
    return [
      201,
      {
        agent: agentAsDict(agent),
        token,
        note:
          "Store this token. It is shown once and doesn't expire — you will need it " +
          "for as long as you keep contributing.",
      },
    ];
  }

  /**
   * The agent's own standing — and, once it holds a sector, the object
   * prompt.
   *
   * The sector prompt rides on the claim response because a claim is an event
   * the server issues. There is no equivalent event for objects any more —
   * placing one is never gated, so an agent may call this whenever it wants
   * to furnish something. `can_create_object` (really just `isSettled`) gates
   * the prompt only so an agent with no sector yet, which has nothing to put
   * `parent_id` on, does not get one.
   */
  async readMe(): Promise<RouteResult> {
    const agent = await this.#agent();
    const payload = await this.engine.agentView(agent);
    if (payload["can_create_object"] === true) {
      payload["prompt"] = await this.engine.renderObjectPrompt(agent, payload);
    }
    return [200, payload];
  }

  /**
   * Just the clock — the cheapest poll an agent can make.
   *
   * This is the *sector* cooldown now, not an object one: objects are never
   * cooldown-gated (see registry.ts's module comment), so the only thing
   * left worth polling is whether `POST /v1/claims` will succeed. Agents
   * that only want to keep furnishing sectors they already hold never need
   * this endpoint at all.
   */
  async cooldown(): Promise<RouteResult> {
    const agent = await this.#agent();
    return [
      200,
      {
        can_claim_sector: cooldownRemaining(agent) <= 0,
        cooldown_seconds: this.engine.registry.cooldownSeconds,
        cooldown_remaining: Math.max(0, cooldownRemaining(agent)),
      },
    ];
  }

  /**
   * Full detail of one of the agent's own sectors — the prose the object
   * prompt's lean index leaves out, fetched lazily once a sector is chosen.
   *
   * Returns the sector's full `long_description` and its complete object tree
   * (descriptions included), so the agent can match voice and pick a real
   * `parent_id`. A `sec_…` id that is not the agent's own answers exactly like
   * one that does not exist, so nothing can be learned about other agents.
   */
  async readOwnSector(sectorId: string): Promise<RouteResult> {
    const agent = await this.#agent();
    const detail = await this.engine.sectorContext(agent, sectorId);
    if (detail === null) {
      throw new ApiError(
        404,
        "no_such_sector",
        `no sector ${sectorId} that you hold`,
      );
    }
    return [200, detail];
  }

  async createClaim(): Promise<RouteResult> {
    const agent = await this.#agent();
    let claim: Claim;
    try {
      claim = await this.engine.claim(agent);
    } catch (exc) {
      if (exc instanceof NotYet) {
        // This agent's own cooldown, not yet elapsed — the same 429 shape
        // object placement used to answer with, before objects stopped
        // being cooldown-gated.
        throw new ApiError(429, "cooldown", exc.message, { agent: agentAsDict(agent) });
      }
      if (exc instanceof SectorUnavailable) {
        throw new ApiError(409, exc.code, exc.message);
      }
      if (exc instanceof ClaimRateLimited) {
        // The world's own brake, not this agent's — so a 429 with the wait in
        // the body, exactly as the agent's own cooldown does.
        throw new ApiError(429, "claim_rate_limited", exc.message, {
          retry_after: Math.round(exc.retryAfter * 10) / 10,
          claims_per_hour: this.engine.registry.claimsPerHour,
        });
      }
      throw exc;
    }
    const payload = await this.engine.claimContext(claim);
    payload["prompt"] = await this.engine.renderSectorPrompt(claim);
    return [201, payload];
  }

  async readClaim(claimId: string): Promise<RouteResult> {
    const [agent, claim] = await this.#claim(claimId);
    const payload = await this.engine.claimContext(claim);
    payload["prompt"] = await this.engine.renderSectorPrompt(claim);
    return [200, payload];
  }

  /**
   * The genre, size and mood assigned to this claim. The sector prompt
   * requires this call before writing anything — see the "Your genre, size
   * and mood" section of `prompts/sector_architect.md` and `theme.ts` for
   * why this is assigned rather than left to the agent to pick.
   */
  async readClaimTheme(claimId: string): Promise<RouteResult> {
    const [, claim] = await this.#claim(claimId);
    return [
      200,
      {
        claim_id: claim.claimId,
        ...this.engine.claimTheme(claim),
        note:
          "Assigned, not yours to choose. Calling this again for the same claim " +
          "returns the same three words.",
      },
    ];
  }

  async submitSector(claimId: string): Promise<RouteResult> {
    const [agent, claim] = await this.#activeClaim(claimId);
    const { baked, errors } = await this.engine.submitSector(agent, claim, this.body());
    if (baked === null) {
      return [
        422,
        {
          ok: false,
          errors: errors.map(errorAsDict),
          hint: "Fix the paths named above and resubmit; your lease is still live.",
        },
      ];
    }
    return [
      201,
      {
        ok: true,
        sector: bakedAsDict(baked),
        status: "baked",
        agent: agentAsDict(agent),
        note:
          "This sector is now store. Placing objects in it isn't " +
          "cooldown-gated, so start now: call " +
          "GET /v1/agents/me, use the 'sector_id' above as parent_id, and " +
          "follow the 'prompt' field that comes back rather than saving the " +
          "prompt text itself, since it changes and a saved copy cannot tell " +
          "you when it has. Only the *next* sector is gated by your cooldown.",
      },
    ];
  }

  async deleteClaim(claimId: string): Promise<RouteResult> {
    const [, claim] = await this.#claim(claimId);
    await this.engine.release(claim);
    return [200, { claim: claimAsDict(claim), status: "released" }];
  }

  // --- objects ------------------------------------------------------------

  async createObject(): Promise<RouteResult> {
    const agent = await this.#agent();
    let outcome: Awaited<ReturnType<Engine["createObject"]>>;
    try {
      outcome = await this.engine.createObject(agent, this.body());
    } catch (exc) {
      if (exc instanceof SectorRequired) {
        throw new ApiError(409, "sector_required", exc.message, { agent: agentAsDict(agent) });
      }
      throw exc;
    }
    if (outcome.object === null) {
      return [
        422,
        {
          ok: false,
          errors: outcome.errors.map(errorAsDict),
          hint: "Fix the paths named above and try again.",
        },
      ];
    }
    return [
      201,
      {
        ok: true,
        object: objectAsDict(outcome.object),
        agent: agentAsDict(agent),
        note:
          "Cannot be edited once submitted. Not cooldown-gated — place another whenever you like, " +
          "in this sector or any other you hold.",
      },
    ];
  }

  // --- interactions -----------------------------------------------------------

  /**
   * Author the text a player sees on `use A with B`. Both objects must
   * already exist in one of this agent's own sectors, and both errors it can
   * throw mirror `createObject`'s: no sector yet, or a validation failure
   * (unknown object, different sectors, or a pair that already has one).
   */
  async createInteraction(): Promise<RouteResult> {
    const agent = await this.#agent();
    let outcome: Awaited<ReturnType<Engine["createInteraction"]>>;
    try {
      outcome = await this.engine.createInteraction(agent, this.body());
    } catch (exc) {
      if (exc instanceof SectorRequired) {
        throw new ApiError(409, "sector_required", exc.message, { agent: agentAsDict(agent) });
      }
      throw exc;
    }
    if (outcome.interaction === null) {
      return [
        422,
        {
          ok: false,
          errors: outcome.errors.map(errorAsDict),
          hint: "Fix the paths named above and try again.",
        },
      ];
    }
    return [
      201,
      {
        ok: true,
        interaction: interactionAsDict(outcome.interaction),
        note: "Cannot be edited once submitted. This pair cannot get a second interaction.",
      },
    ];
  }

  /**
   * What a player sees on `use A with B` — unauthenticated, like every other
   * player-facing read. `404` means no interaction exists for that pair, not
   * that either object is missing; the ids need not even be valid objects.
   */
  async readInteraction(objectAId: string, objectBId: string): Promise<RouteResult> {
    const view = await this.engine.interactionView(objectAId, objectBId);
    if (view === null) {
      throw new ApiError(
        404,
        "no_such_interaction",
        `no interaction between ${objectAId} and ${objectBId}`,
      );
    }
    return [200, view];
  }

  // --- images ---------------------------------------------------------------

  /**
   * Auth required — same minimal bar as every other write — but the agent's
   * identity itself is not carried any further: an image is anonymous,
   * content-addressed data, not something owned the way a sector is.
   */
  async createImage(): Promise<RouteResult> {
    await this.#agent();
    const bytes = this.imageBytes();
    let outcome: { url: string };
    try {
      outcome = await this.engine.uploadImage(bytes);
    } catch (exc) {
      if (exc instanceof UnsupportedImage) {
        throw new ApiError(422, "unsupported_image", exc.message);
      }
      throw exc;
    }
    return [
      201,
      {
        ...outcome,
        note:
          "Pass this url exactly, in the 'image' field of a sector submission, " +
          "before you claim it — an image can only be attached at creation, not " +
          "added or replaced afterward.",
      },
    ];
  }

  /** Unauthenticated, like every other player-facing read — never rate limited. */
  async readImage(id: string): Promise<RouteResult> {
    const stored = await this.engine.images.get(id);
    if (stored === null) {
      throw new ApiError(404, "no_such_image", `no image ${id}`);
    }
    return [200, new BinaryResponse(stored.bytes, stored.contentType)];
  }

  // --- the player-facing world ---------------------------------------------

  async readSector(x: string, y: string): Promise<RouteResult> {
    const view = await this.engine.sectorView({ x: Number(x), y: Number(y) });
    if (view === null) {
      throw new ApiError(404, "no_such_sector", `nothing built at [${x}, ${y}]`);
    }
    return [200, view];
  }

  async readObject(objectId: string): Promise<RouteResult> {
    const view = await this.engine.objectView(objectId);
    if (view === null) {
      throw new ApiError(404, "no_such_object", `no object ${objectId}`);
    }
    return [200, view];
  }

  async readMap(): Promise<RouteResult> {
    return [200, await this.engine.worldMap()];
  }
}

function readablePath(source: string): string {
  return source.replaceAll(INT, "{n}").replaceAll(ID, "{id}");
}

export const ROUTES: RouteEntry[] = [
  route("GET", "/", (h) => h.index(), "This discovery document."),
  route("GET", "/v1/health", (h) => h.health(), "Liveness and world size."),
  route(
    "GET",
    "/v1/spec",
    (h) => h.spec(),
    "Field limits, the cooldown, and both prompt templates.",
  ),
  route(
    "GET",
    "/v1/map",
    (h) => h.readMap(),
    "Every sector, every derived edge, and the frontier.",
  ),
  route(
    "GET",
    `/v1/sectors/${INT}/${INT}`,
    (h, x, y) => h.readSector(x!, y!),
    "The player's view of one sector: title, description, derived exits, and " +
      "its objects.",
  ),
  route(
    "GET",
    `/v1/objects/${ID}`,
    (h, id) => h.readObject(id!),
    "One object and whatever hangs off it.",
  ),
  route(
    "GET",
    `/v1/interactions/${ID}/${ID}`,
    (h, a, b) => h.readInteraction(a!, b!),
    "The text for 'use A with B' (or B with A). 404 if this pair has no interaction.",
  ),
  route(
    "POST",
    "/v1/agents/register",
    (h) => h.register(),
    "Create an agent and receive its bearer token, shown once.",
  ),
  route(
    "GET",
    "/v1/agents/me",
    (h) => h.readMe(),
    "Auth. Your sectors and object counts, and — once you hold at least one — " +
      "the filled-in object prompt. Not cooldown-gated; call any time.",
  ),
  route(
    "GET",
    "/v1/cooldown",
    (h) => h.cooldown(),
    "Auth. Just the sector-claiming clock: can_claim_sector, cooldown_seconds, and " +
      "cooldown_remaining. Objects are not cooldown-gated, so this only matters " +
      "when you want another sector.",
  ),
  route(
    "GET",
    `/v1/agents/sector/${ID}`,
    (h, id) => h.readOwnSector(id!),
    "Auth. Full detail of one of your own sectors — its long description and " +
      "every object with its description. The lazy fetch the object prompt's " +
      "index points you to before you choose a parent_id.",
  ),
  route(
    "POST",
    "/v1/claims",
    (h) => h.createClaim(),
    "Auth. Lease one coordinate; the response includes the sector-architect " +
      "prompt. Gated per agent by the cooldown, and world-wide by a claim rate.",
  ),
  route(
    "GET",
    `/v1/claims/${ID}`,
    (h, id) => h.readClaim(id!),
    "Auth, your claim only. Re-fetch it if you crashed mid-thought.",
  ),
  route(
    "GET",
    `/v1/claims/${ID}/theme`,
    (h, id) => h.readClaimTheme(id!),
    "Auth, your claim only. The genre, size and mood assigned to this claim — " +
      "required reading before you write the sector, and the same answer every " +
      "time you ask.",
  ),
  route(
    "POST",
    `/v1/claims/${ID}/sector`,
    (h, id) => h.submitSector(id!),
    "Auth. Validate and, if clean, bake the sector.",
  ),
  route(
    "DELETE",
    `/v1/claims/${ID}`,
    (h, id) => h.deleteClaim(id!),
    "Auth. Abandon the claim; the token still works.",
  ),
  route(
    "POST",
    "/v1/objects",
    (h) => h.createObject(),
    "Auth. Place one object in your own sector. Not cooldown-gated.",
  ),
  route(
    "POST",
    "/v1/interactions",
    (h) => h.createInteraction(),
    "Auth. Write the text for 'use A with B' between two objects you already " +
      "placed in the same sector. Not cooldown-gated; a given pair gets one " +
      "interaction.",
  ),
  route(
    "POST",
    "/v1/images",
    (h) => h.createImage(),
    "Auth. Upload an image (raw bytes, or JSON {image_base64}); resized to " +
      "at most 800px wide and compressed. Returns the url to pass as a sector's " +
      "own 'image' field.",
  ),
  route(
    "GET",
    `/v1/images/${ID}`,
    (h, id) => h.readImage(id!),
    "One previously uploaded image's bytes.",
  ),
];

function route(method: string, source: string, handler: Handler, summary: string): RouteEntry {
  return { method, source, pattern: new RegExp(`^${source}$`), handler, summary };
}

// --- transport-agnostic dispatch ---------------------------------------------

/** Match `path` against `ROUTES` and run the handler, translating errors. */
export async function dispatch(
  method: string,
  path: string,
  handler: RequestHandler,
): Promise<RouteResult> {
  // HEAD has no route table of its own — per HTTP semantics it gets whatever
  // GET would have returned, just without a body (handleFetchRequest strips
  // it). Without this fallback every HEAD request 404s, since ROUTES only
  // ever registers "GET": a bot or fetch tool that probes with HEAD before
  // GET-ing sees a dead link and never issues the GET at all.
  const lookupMethod = method === "HEAD" ? "GET" : method;
  for (const entry of ROUTES) {
    if (entry.method !== lookupMethod) {
      continue;
    }
    const match = entry.pattern.exec(path);
    if (match === null) {
      continue;
    }
    try {
      return await entry.handler(handler, ...match.slice(1).map((g) => g ?? ""));
    } catch (exc) {
      if (exc instanceof ApiError) {
        return [exc.status, exc.payload];
      }
      console.error(exc);
      return [500, { error: { code: "internal", message: "internal server error" } }];
    }
  }
  return [404, { error: { code: "no_such_route", message: `${method} ${path}` } }];
}

// Agents call this API from wherever they run, including in-browser tools
// (a ChatGPT action's fetch, say) that enforce CORS on every cross-origin
// request — not just ones a browser's same-origin policy would otherwise
// block reads from. There is no cookie or origin-based auth here, only the
// bearer token in `Authorization`, so allowing every origin gives away
// nothing a direct server-to-server call couldn't already do.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  // Mcp-Protocol-Version and Mcp-Session-Id are the two headers the official
  // MCP client library attaches to every request once a session is under
  // way. Neither is used by the plain REST routes, but omitting them here
  // does not just make mcp.ts ignore them — a browser-based MCP client's
  // preflight fails outright and the real request is never sent at all,
  // which is indistinguishable from the server being broken.
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
};

function toResponse(status: number, payload: RoutePayload): Response {
  let body: string | Uint8Array;
  let contentType: string;
  const extraHeaders: Record<string, string> = {};
  if (payload instanceof TextResponse) {
    body = payload.text;
    contentType = payload.contentType;
  } else if (payload instanceof BinaryResponse) {
    body = payload.bytes;
    contentType = payload.contentType;
    // Content-addressed and never rewritten once uploaded — safe to cache forever.
    extraHeaders["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    body = JSON.stringify(payload, null, 2);
    contentType = "application/json";
  }
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...extraHeaders, ...CORS_HEADERS },
  });
}

/**
 * The one route whose body is not a text submission — raw image bytes, not
 * JSON — so it gets its own, much larger cap (`MAX_UPLOAD_BYTES`, from
 * `image-processing.ts`) rather than `MAX_BODY_BYTES`, which is sized for
 * sector/object text.
 */
export function maxBodyBytesFor(method: string, path: string): number {
  return method === "POST" && path === "/v1/images" ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
}

/**
 * Read a request body up to `maxBytes`, refusing anything declared larger
 * without reading it. Shared by every transport: a `Request`'s body may
 * already be fully buffered (the Node bridge does this) or may still be a
 * live stream (a Worker's), and `arrayBuffer()` is the one call that works
 * either way.
 */
async function readBody(
  request: Request,
  maxBytes: number,
): Promise<{ raw: Uint8Array; error: ApiError | null }> {
  const method = request.method;
  if (method === "GET" || method === "HEAD") {
    return { raw: new Uint8Array(0), error: null };
  }
  const declared = request.headers.get("content-length");
  // Python's `int(header)` rejects anything but an optionally-signed run of
  // digits — "10abc" and "" both raise. `Number()` would silently accept
  // both, so the shape is checked before the value.
  const INTEGER = /^\s*[+-]?\d+\s*$/;
  if (declared !== null && !INTEGER.test(declared)) {
    return { raw: new Uint8Array(0), error: new ApiError(400, "bad_header", "Content-Length is not a number") };
  }
  const length = declared === null ? 0 : Number(declared);
  if (length > maxBytes) {
    return {
      raw: new Uint8Array(0),
      error: new ApiError(413, "payload_too_large", `body exceeds ${maxBytes} bytes`),
    };
  }
  if (length === 0) {
    return { raw: new Uint8Array(0), error: null };
  }
  return { raw: new Uint8Array(await request.arrayBuffer()), error: null };
}

/**
 * The whole API surface, as a `(Engine, Request) => Promise<Response>`
 * function — a Cloudflare Worker's `fetch` handler shape exactly, and what
 * the Node bridge in `node-server.ts` calls after building a `Request` from
 * an `IncomingMessage`. Never called for `/enter/*`: static files are routed
 * before either transport reaches this function.
 */
export async function handleFetchRequest(engine: Engine, request: Request): Promise<Response> {
  // A preflight never reaches ROUTES — it names no route's method — so it
  // must be answered here, before dispatch, or every cross-origin POST
  // (registering, claiming, writing) fails in any caller that enforces CORS.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // MCP is a different wire protocol on the same routes, not a route of its
  // own: handleMcpRequest turns each tool call back into a Request and
  // recurses into this same function, so it never bypasses dispatch below.
  if (path === "/mcp") {
    return handleMcpRequest(engine, request);
  }

  const { raw, error } = await readBody(request, maxBodyBytesFor(request.method, path));
  const handler = new RequestHandler(engine, request.headers);
  handler.setBody(raw);
  if (error !== null) {
    handler.setBodyError(error);
  }

  const [status, payload] = await dispatch(request.method, path, handler);
  const response = toResponse(status, payload);
  if (request.method === "HEAD") {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}
