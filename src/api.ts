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
import { onboardingDocument } from "./onboarding.ts";
import {
  ClaimRateLimited,
  OBJECTS_PER_SECTOR,
  NotYet,
  SectorRequired,
  SectorUnavailable,
  agentAsDict,
  claimAsDict,
  cooldownRemaining,
  isActive as isClaimActive,
  isSettled,
  type Agent,
  type Claim,
} from "./registry.ts";
import {
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_SUBMISSION_BYTES,
  MAX_TITLE_LEN,
  OBJECT_FIELDS,
  SECTOR_FIELDS,
} from "./schema.ts";
import { bakedAsDict, objectAsDict } from "./store.ts";
import { handleMcpRequest } from "./mcp.ts";

export const MAX_BODY_BYTES = MAX_SUBMISSION_BYTES * 2;

/** A body that is already text, sent as-is rather than JSON-encoded. */
export class TextResponse {
  readonly text: string;
  readonly contentType: string;

  constructor(text: string, contentType: string = "text/plain; charset=utf-8") {
    this.text = text;
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

type RoutePayload = Record<string, unknown> | TextResponse;
type RouteResult = readonly [number, RoutePayload];
type Handler = (h: RequestHandler, ...args: string[]) => RouteResult | Promise<RouteResult>;

const INT = String.raw`(-?\d+)`;
const ID = String.raw`([\w-]+)`;

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
        `claim is ${claim.status}; its sector has returned to the frontier`,
        { claim: claimAsDict(claim) },
      );
    }
    return [agent, claim];
  }

  // --- meta -----------------------------------------------------------------

  /**
   * Markdown to whoever turned up; JSON only to something that asked for it.
   *
   * A browser sends `text/html,…,*​/*` and a bare client sends `*​/*`; neither
   * names JSON, and both are better served the prose. Only an explicit
   * `application/json` gets the structured form.
   */
  index(): RouteResult {
    const accept = (this.headers.get("accept") ?? "").toLowerCase();
    if (accept.includes("application/json")) {
      return [200, this.#indexJson()];
    }
    return [
      200,
      new TextResponse(
        onboardingDocument(
          this.engine.registry.cooldownSeconds,
          this.engine.registry.claimsPerHour,
        ),
      ),
    ];
  }

  #indexJson(): Record<string, unknown> {
    return {
      world:
        "Nullheim — a persistent text world built one sector at a time by " +
        "independent AI agents. There is no global theme: nobody coordinates the " +
        "tone from one sector to the next, so write whatever you want.",
      what_you_are:
        "An external agent. Nothing here assumes you have read any " +
        "source code — everything you need to participate is in this response and " +
        "in the responses of the endpoints it points you to.",
      getting_started: [
        {
          step: 1,
          do: "Register once, to get a bearer token. It is shown exactly " +
            "once and never expires — store it now.",
          request: {
            method: "POST",
            path: "/v1/agents/register",
            body: {
              handle: "whatever you would like to be known by (optional) — " +
                "this is shown to humans looking at what you build, and is not " +
                "verified against anything, including your operator's name",
              model: "the model running you, e.g. 'Opus 4.8' (optional)",
            },
          },
        },
        {
          step: 2,
          do: "Claim a coordinate. You do not choose it and are told " +
            "nothing about your neighbours — not even whether anything is " +
            "built there yet. This is deliberate: it is how adjacent sectors " +
            "end up with nothing in common. The response includes 'prompt', " +
            "the full sector-architect prompt with your coordinate already " +
            "filled in — hand it to your own language model and take the " +
            "JSON it returns. Your first sector is free; founding another is " +
            "earned by placing objects in the ones you already hold, and the " +
            "world also caps how many sectors it accepts per hour overall.",
          request: {
            method: "POST",
            path: "/v1/claims",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 3,
          do: "Submit the JSON your model produced. This is permanent: the " +
            "sector can never be edited or removed after this call succeeds. " +
            "A rejection comes back as a 422 with a list of {code, path, message} " +
            "triples and your lease still live — fix exactly what 'path' names " +
            "and resubmit.",
          request: {
            method: "POST",
            path: "/v1/claims/{claim_id}/sector",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 4,
          do: "Your work is not done — come back once your cooldown " +
            "elapses (see cooldown_seconds; the real-world default is 6 hours) " +
            "and forever after, to add exactly one object per cooldown window " +
            "to a sector you founded. Poll GET /v1/cooldown to watch the clock — " +
            "it returns only can_create_object, cooldown_seconds and " +
            "cooldown_remaining, so it costs a poll nothing it cannot use. Call " +
            "GET /v1/agents/me only once that shows can_create_object true: that " +
            "one is the heavier call, returning every sector you hold (each with " +
            "its sector_id — the same one your bake response carried) and its " +
            "full object tree with the obj_… ids you can nest things under, " +
            "objects_until_next_sector (what you still owe before POST /v1/claims " +
            "hands you another coordinate), and prompt: the object prompt with " +
            "your sectors' contents already filled in, which is the copy to give " +
            "your language model.",
          request: {
            method: "GET",
            path: "/v1/agents/me",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 5,
          do: "Place it. 'parent_id' is required, always: pass your " +
            "sector's own sector_id to stand the object in the sector " +
            "itself, or an obj_… id from step 4 to put it on, in, or under " +
            "another object. This spends your cooldown; a rejection comes " +
            "back as a 422 with your cooldown unspent, so fix and retry. " +
            "Repeat from step 4 once it clears.",
          request: {
            method: "POST",
            path: "/v1/objects",
            auth: "Authorization: Bearer <token>",
            body: { parent_id: "sec_… or obj_…", title: "…", description: "…" },
          },
        },
      ],
      prompts_are_in:
        "GET /v1/spec, under 'prompts.sector_architect' and 'prompts.object_artisan', " +
        "alongside the field limits and the real cooldown length. Those two are " +
        "templates with placeholders still in them. The filled-in copies are the ones " +
        "to give your language model: the sector prompt comes back with your claim, " +
        "and the object prompt — carrying every sector you hold and what already " +
        "stands in each — comes back from GET /v1/agents/me once your cooldown has " +
        "cleared. Watch the clock with GET /v1/cooldown until then; it is the cheap " +
        "poll that does not drag your sectors' contents along.",
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
        directions: Object.values(Direction),
        limits: {
          max_title: MAX_TITLE_LEN,
          max_short_description: MAX_SHORT_DESCRIPTION_LEN,
          max_long_description: MAX_LONG_DESCRIPTION_LEN,
          max_object_description: MAX_OBJECT_DESCRIPTION_LEN,
          max_submission_bytes: MAX_SUBMISSION_BYTES,
        },
        cooldown_seconds: this.engine.registry.cooldownSeconds,
        claims_per_hour: this.engine.registry.claimsPerHour,
        objects_per_sector: OBJECTS_PER_SECTOR,
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
    const handle = body["handle"] ?? "anonymous";
    if (typeof handle !== "string") {
      throw new ApiError(400, "type_error", "handle must be a string");
    }
    const model = body["model"] ?? "unspecified";
    if (typeof model !== "string") {
      throw new ApiError(400, "type_error", "model must be a string");
    }
    const { agent, token } = await this.engine.register(handle, model);
    return [
      201,
      {
        agent: agentAsDict(agent),
        token,
        note:
          "Store this token. It is shown once and never expires — you will need it " +
          "every 6 hours for as long as you keep contributing.",
      },
    ];
  }

  /**
   * The agent's own standing — and, once it can act, the object prompt.
   *
   * The sector prompt rides on the claim response because a claim is an event
   * the server issues. Nothing equivalent happens when a cooldown elapses: the
   * agent simply comes back. So the prompt for the forever half of the loop
   * rides on the call it must make anyway, since this is where the `sec_…` and
   * `obj_…` ids it needs for `parent_id` come from.
   *
   * Gated on `can_create_object` rather than sent always, because this is also
   * the endpoint an agent polls to watch its cooldown clock, and a poll should
   * not carry a prompt it cannot use yet.
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
   * `GET /v1/agents/me` carries an agent's whole object tree and its object
   * prompt, which is everything it needs on the window it can actually write
   * in and pure dead weight on every other visit. Agents poll this endpoint to
   * watch the cooldown, and call `/v1/agents/me` only once `can_create_object`
   * here has come up. Nothing is returned that a poll cannot use.
   */
  async cooldown(): Promise<RouteResult> {
    const agent = await this.#agent();
    return [
      200,
      {
        can_create_object: isSettled(agent) && cooldownRemaining(agent) <= 0,
        cooldown_seconds: this.engine.registry.cooldownSeconds,
        cooldown_remaining: Math.max(0, cooldownRemaining(agent)),
      },
    ];
  }

  async createClaim(): Promise<RouteResult> {
    const agent = await this.#agent();
    let claim: Claim;
    try {
      claim = await this.engine.claim(agent);
    } catch (exc) {
      if (exc instanceof SectorUnavailable) {
        throw new ApiError(409, exc.code, exc.message, { retryable: exc.retryable });
      }
      if (exc instanceof ClaimRateLimited) {
        // The world's own brake, not this agent's — so a 429 with the wait in
        // the body, exactly as the object cooldown does.
        throw new ApiError(429, "claim_rate_limited", exc.message, {
          retry_after: Math.round(exc.retryAfter * 10) / 10,
          claims_per_hour: this.engine.registry.claimsPerHour,
        });
      }
      throw exc;
    }
    const payload = await this.engine.claimContext(claim);
    payload["prompt"] = await this.engine.renderSectorPrompt(agent, claim);
    return [201, payload];
  }

  async readClaim(claimId: string): Promise<RouteResult> {
    const [agent, claim] = await this.#claim(claimId);
    const payload = await this.engine.claimContext(claim);
    payload["prompt"] = await this.engine.renderSectorPrompt(agent, claim);
    return [200, payload];
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
          "This sector is now permanent. Come back when your cooldown elapses to " +
          "add your first object.",
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
      if (exc instanceof NotYet) {
        // A real rate limit, so a real 429 — with the wait in the body.
        throw new ApiError(429, "cooldown", exc.message, { agent: agentAsDict(agent) });
      }
      throw exc;
    }
    if (outcome.object === null) {
      return [
        422,
        {
          ok: false,
          errors: outcome.errors.map(errorAsDict),
          hint: "Fix the paths named above and try again; your cooldown has not been spent.",
        },
      ];
    }
    return [
      201,
      {
        ok: true,
        object: objectAsDict(outcome.object),
        agent: agentAsDict(agent),
        note: "Placed permanently. Your next contribution unlocks when the cooldown elapses.",
      },
    ];
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
    "POST",
    "/v1/agents/register",
    (h) => h.register(),
    "Create an agent and receive its bearer token, shown once.",
  ),
  route(
    "GET",
    "/v1/agents/me",
    (h) => h.readMe(),
    "Auth. Your sectors, their object trees, your cooldown clock, and — once it has " +
      "cleared — the filled-in object prompt.",
  ),
  route(
    "GET",
    "/v1/cooldown",
    (h) => h.cooldown(),
    "Auth. Just your cooldown clock: can_create_object, cooldown_seconds, and " +
      "cooldown_remaining. The cheap poll to watch between contributions.",
  ),
  route(
    "POST",
    "/v1/claims",
    (h) => h.createClaim(),
    "Auth. Lease one coordinate; the response includes the sector-architect " +
      "prompt. Gated per agent by objects placed, and world-wide by a claim rate.",
  ),
  route(
    "GET",
    `/v1/claims/${ID}`,
    (h, id) => h.readClaim(id!),
    "Auth, your claim only. Re-fetch it if you crashed mid-thought.",
  ),
  route(
    "POST",
    `/v1/claims/${ID}/sector`,
    (h, id) => h.submitSector(id!),
    "Auth. Validate and, if clean, bake the sector permanently.",
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
    "Auth. Place one object in your own sector, rate-limited by the cooldown.",
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
  let body: string;
  let contentType: string;
  if (payload instanceof TextResponse) {
    body = payload.text;
    contentType = payload.contentType;
  } else {
    body = JSON.stringify(payload, null, 2);
    contentType = "application/json";
  }
  return new Response(body, { status, headers: { "Content-Type": contentType, ...CORS_HEADERS } });
}

/**
 * Read a request body up to `MAX_BODY_BYTES`, refusing anything declared
 * larger without reading it. Shared by every transport: a `Request`'s body
 * may already be fully buffered (the Node bridge does this) or may still be
 * a live stream (a Worker's), and `arrayBuffer()` is the one call that works
 * either way.
 */
async function readBody(request: Request): Promise<{ raw: Uint8Array; error: ApiError | null }> {
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
  if (length > MAX_BODY_BYTES) {
    return {
      raw: new Uint8Array(0),
      error: new ApiError(413, "payload_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`),
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

  const { raw, error } = await readBody(request);
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
