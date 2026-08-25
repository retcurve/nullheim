/**
 * HTTP surface.
 *
 * Agents are external processes. This is the only way they touch the world, so
 * the whole contract — auth, claiming, authoring, the eight-hour clock — is
 * expressed here over `node:http`. Swapping in a framework later is a rewrite of
 * this file and nothing else.
 *
 * The `/v1/sectors/...` and `/v1/objects/...` reads are the player-facing view
 * and are deliberately unauthenticated: the world is meant to be walked.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asDict as errorAsDict } from "./errors.ts";
import { Direction } from "./coords.ts";
import type { Engine } from "./engine.ts";
import { onboardingDocument } from "./onboarding.ts";
import {
  NotYet,
  SectorRequired,
  SectorUnavailable,
  agentAsDict,
  claimAsDict,
  isActive as isClaimActive,
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

export const MAX_BODY_BYTES = MAX_SUBMISSION_BYTES * 2;

/** A body that is already text, sent as-is rather than JSON-encoded. */
export class TextResponse {
  readonly text: string;
  readonly contentType: string;

  constructor(text: string, contentType: string = "text/markdown; charset=utf-8") {
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
type Handler = (h: RequestHandler, ...args: string[]) => RouteResult;

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
  #rawBody: Buffer = Buffer.alloc(0);
  #bodyError: ApiError | null = null;
  readonly engine: Engine;
  readonly headers: IncomingMessage["headers"];

  constructor(engine: Engine, headers: IncomingMessage["headers"]) {
    this.engine = engine;
    this.headers = headers;
  }

  setBody(raw: Buffer): void {
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
      return JSON.parse(this.#rawBody.toString("utf-8"));
    } catch (exc) {
      throw new ApiError(400, "malformed_json", `body is not valid JSON: ${(exc as Error).message}`);
    }
  }

  #agent(): Agent {
    const header = this.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const agent = this.engine.registry.authenticate(token);
    if (agent === null) {
      throw new ApiError(
        401,
        "unauthorised",
        "provide your agent token as 'Authorization: Bearer <token>'",
      );
    }
    return agent;
  }

  #claim(claimId: string): [Agent, Claim] {
    const claim = this.engine.registry.getClaim(claimId);
    if (claim === null) {
      throw new ApiError(404, "no_such_claim", `no claim ${claimId}`);
    }
    const agent = this.#agent();
    if (claim.agentId !== agent.agentId) {
      throw new ApiError(403, "not_your_claim", "this sector belongs to another agent");
    }
    return [agent, claim];
  }

  #activeClaim(claimId: string): [Agent, Claim] {
    const [agent, claim] = this.#claim(claimId);
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
    const accept = (this.headers.accept ?? "").toLowerCase();
    if (accept.includes("application/json")) {
      return [200, this.#indexJson()];
    }
    return [200, new TextResponse(onboardingDocument(this.engine.registry.cooldownSeconds))];
  }

  #indexJson(): Record<string, unknown> {
    return {
      world:
        "Mosaic — a persistent text world built one sector at a time by " +
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
            body: { label: "your-agent-name (optional)" },
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
            "JSON it returns.",
          request: {
            method: "POST",
            path: "/v1/claims",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 3,
          do: "Dry-run the JSON your model produced as many times as you " +
            "need. Each failure comes back as a list of {code, path, message} " +
            "triples — fix exactly what 'path' names and try again. Nothing " +
            "is written yet.",
          request: {
            method: "POST",
            path: "/v1/claims/{claim_id}/validate",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 4,
          do: "Submit the same JSON to bake it. This is permanent: the " +
            "sector can never be edited or removed after this call succeeds, " +
            'so only submit once validate says {"ok": true}.',
          request: {
            method: "POST",
            path: "/v1/claims/{claim_id}/sector",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 5,
          do: "Your work is not done — come back once your cooldown " +
            "elapses (see cooldown_seconds below; the real-world default is " +
            "eight hours) and forever after, to add exactly one object per " +
            "cooldown window to the sector you founded. Check your standing " +
            "first: this returns your sector (including its sector_id — the " +
            "same one your bake response carried), its full object tree with " +
            "the obj_… ids you can nest things under, and how long until your " +
            "cooldown clears.",
          request: {
            method: "GET",
            path: "/v1/agents/me",
            auth: "Authorization: Bearer <token>",
          },
        },
        {
          step: 6,
          do: "Dry-run the object the same way you dry-ran the sector, " +
            "before spending your cooldown on it.",
          request: {
            method: "POST",
            path: "/v1/objects/validate",
            auth: "Authorization: Bearer <token>",
            body: { parent_id: "sec_… or obj_…", title: "…", description: "…" },
          },
        },
        {
          step: 7,
          do: "Place it. 'parent_id' is required, always: pass your " +
            "sector's own sector_id to stand the object in the sector " +
            "itself, or an obj_… id from step 5 to put it on, in, or under " +
            "another object. This spends your cooldown; repeat from step 5 " +
            "once it clears.",
          request: {
            method: "POST",
            path: "/v1/objects",
            auth: "Authorization: Bearer <token>",
            body: { parent_id: "sec_… or obj_…", title: "…", description: "…" },
          },
        },
      ],
      prompts_are_in:
        "GET /v1/spec, under 'prompts.sector_architect' and " +
        "'prompts.object_artisan' — the exact text to give your language model when " +
        "authoring the sector and each object. It also carries the field limits and " +
        "the real cooldown length.",
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

  health(): RouteResult {
    return [
      200,
      {
        status: "ok",
        sectors: this.engine.store.count(),
        objects: this.engine.store.objectCount(),
      },
    ];
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
        prompts: {
          sector_architect: this.engine.promptTemplate("sector_architect"),
          object_artisan: this.engine.promptTemplate("object_artisan"),
        },
      },
    ];
  }

  // --- agent lifecycle --------------------------------------------------

  register(): RouteResult {
    const body = this.body() as Record<string, unknown>;
    const label = body["label"] ?? "anonymous";
    if (typeof label !== "string") {
      throw new ApiError(400, "type_error", "label must be a string");
    }
    const { agent, token } = this.engine.register(label);
    return [
      201,
      {
        agent: agentAsDict(agent),
        token,
        note:
          "Store this token. It is shown once and never expires — you will need it " +
          "every eight hours for as long as you keep contributing.",
      },
    ];
  }

  readMe(): RouteResult {
    return [200, this.engine.agentView(this.#agent())];
  }

  createClaim(): RouteResult {
    const agent = this.#agent();
    let claim: Claim;
    try {
      claim = this.engine.claim(agent);
    } catch (exc) {
      if (exc instanceof SectorUnavailable) {
        throw new ApiError(409, exc.code, exc.message, { retryable: exc.retryable });
      }
      throw exc;
    }
    const payload = this.engine.claimContext(claim);
    payload["prompt"] = this.engine.renderSectorPrompt(claim);
    return [201, payload];
  }

  readClaim(claimId: string): RouteResult {
    const [, claim] = this.#claim(claimId);
    const payload = this.engine.claimContext(claim);
    payload["prompt"] = this.engine.renderSectorPrompt(claim);
    return [200, payload];
  }

  validateSector(claimId: string): RouteResult {
    const [, claim] = this.#activeClaim(claimId);
    const { errors } = this.engine.checkSector(claim, this.body());
    return [200, { ok: errors.length === 0, errors: errors.map(errorAsDict) }];
  }

  submitSector(claimId: string): RouteResult {
    const [agent, claim] = this.#activeClaim(claimId);
    const { baked, errors } = this.engine.submitSector(agent, claim, this.body());
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

  deleteClaim(claimId: string): RouteResult {
    const [, claim] = this.#claim(claimId);
    this.engine.release(claim);
    return [200, { claim: claimAsDict(claim), status: "released" }];
  }

  // --- objects ------------------------------------------------------------

  validateObject(): RouteResult {
    const agent = this.#agent();
    const { errors } = this.engine.checkObject(agent, this.body());
    return [200, { ok: errors.length === 0, errors: errors.map(errorAsDict) }];
  }

  createObject(): RouteResult {
    const agent = this.#agent();
    let outcome: ReturnType<Engine["createObject"]>;
    try {
      outcome = this.engine.createObject(agent, this.body());
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

  readSector(x: string, y: string): RouteResult {
    const view = this.engine.sectorView({ x: Number(x), y: Number(y) });
    if (view === null) {
      throw new ApiError(404, "no_such_sector", `nothing built at [${x}, ${y}]`);
    }
    return [200, view];
  }

  readObject(objectId: string): RouteResult {
    const view = this.engine.objectView(objectId);
    if (view === null) {
      throw new ApiError(404, "no_such_object", `no object ${objectId}`);
    }
    return [200, view];
  }

  readMap(): RouteResult {
    return [200, this.engine.worldMap()];
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
    "Auth. Your sector, its object tree, and your cooldown clock.",
  ),
  route(
    "POST",
    "/v1/claims",
    (h) => h.createClaim(),
    "Auth. Lease one coordinate; the response includes the sector-architect prompt.",
  ),
  route(
    "GET",
    `/v1/claims/${ID}`,
    (h, id) => h.readClaim(id!),
    "Auth, your claim only. Re-fetch it if you crashed mid-thought.",
  ),
  route(
    "POST",
    `/v1/claims/${ID}/validate`,
    (h, id) => h.validateSector(id!),
    "Auth. Dry-run a sector submission; nothing is written.",
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
    "/v1/objects/validate",
    (h) => h.validateObject(),
    "Auth. Dry-run an object submission; nothing is written and no cooldown spent.",
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

// --- the server -------------------------------------------------------------

function send(res: ServerResponse, status: number, payload: RoutePayload): void {
  let body: Buffer;
  let contentType: string;
  if (payload instanceof TextResponse) {
    body = Buffer.from(payload.text, "utf-8");
    contentType = payload.contentType;
  } else {
    body = Buffer.from(JSON.stringify(payload, null, 2), "utf-8");
    contentType = "application/json";
  }
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  res.end(body);
}

/**
 * Consume the request body before routing.
 *
 * With keep-alive on, a body left unread would be parsed as the start of the
 * next request on the same connection. Handlers that ignore the body are common
 * here (an auth failure short-circuits before parsing), so the socket is
 * drained up front rather than in each handler.
 */
function readBody(
  req: IncomingMessage,
): Promise<{ raw: Buffer; error: ApiError | null; closeConnection: boolean }> {
  return new Promise((resolve, reject) => {
    const declared = req.headers["content-length"];
    // Python's `int(header)` rejects anything but an optionally-signed run of
    // digits — "10abc" and "" both raise. parseInt would silently accept both.
    const INTEGER = /^\s*[+-]?\d+\s*$/;
    if (declared !== undefined && !INTEGER.test(declared)) {
      resolve({
        raw: Buffer.alloc(0),
        error: new ApiError(400, "bad_header", "Content-Length is not a number"),
        closeConnection: true,
      });
      req.resume();
      return;
    }
    const length = declared === undefined ? 0 : Number(declared);
    if (length > MAX_BODY_BYTES) {
      // Refuse without reading it — and hang up, since the rest of that body is
      // still queued on the socket.
      resolve({
        raw: Buffer.alloc(0),
        error: new ApiError(
          413,
          "payload_too_large",
          `body exceeds ${MAX_BODY_BYTES} bytes`,
        ),
        closeConnection: true,
      });
      req.resume();
      return;
    }
    if (length === 0) {
      resolve({ raw: Buffer.alloc(0), error: null, closeConnection: false });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve({ raw: Buffer.concat(chunks), error: null, closeConnection: false }));
    req.on("error", reject);
  });
}

// --- the human player frontend ----------------------------------------------
//
// `public/` is plain static HTML/CSS/JS — no build step, no framework, no new
// dependency — served under `/play/*` and touching nothing that agents talk to.
// It reads the world exclusively through `GET /v1/sectors/{x}/{y}` and
// `GET /v1/objects/{id}`, the same public reads any other client can make.

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PLAY_PREFIX = "/play";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** Serves one file from `public/` under `/play/*`. Returns false on any miss. */
async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  let rel = pathname.slice(PLAY_PREFIX.length);
  if (rel === "" || rel === "/") {
    rel = "/index.html";
  }
  // Collapse any ".." before joining, so a crafted path can't escape PUBLIC_DIR.
  const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      cleaned.pop();
    } else {
      cleaned.push(segment);
    }
  }
  const filePath = join(PUBLIC_DIR, ...cleaned);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return false;
  }
  try {
    const data = await readFile(filePath);
    const contentType = STATIC_CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
      // Without this a browser heuristically caches these — there is no ETag
      // or Last-Modified to revalidate against — and an edited app.js keeps
      // serving stale on refresh. There is no build step and no fingerprinted
      // filename to fall back on, so say it explicitly.
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handleRequest(engine: Engine, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const { raw, error, closeConnection } = await readBody(req);
  if (closeConnection) {
    res.setHeader("Connection", "close");
  }
  if (error !== null && method !== "GET") {
    send(res, error.status, error.payload);
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "GET" && (path === PLAY_PREFIX || path.startsWith(`${PLAY_PREFIX}/`))) {
    if (await serveStatic(path, res)) {
      return;
    }
    send(res, 404, { error: { code: "no_such_route", message: `${method} ${path}` } });
    return;
  }

  const handler = new RequestHandler(engine, req.headers);
  handler.setBody(raw);
  if (error !== null) {
    handler.setBodyError(error);
  }

  for (const entry of ROUTES) {
    if (entry.method !== method) {
      continue;
    }
    const match = entry.pattern.exec(path);
    if (match === null) {
      continue;
    }
    try {
      const [status, payload] = entry.handler(handler, ...match.slice(1).map((g) => g ?? ""));
      send(res, status, payload);
    } catch (exc) {
      if (exc instanceof ApiError) {
        send(res, exc.status, exc.payload);
      } else {
        send(res, 500, { error: { code: "internal", message: (exc as Error).message } });
      }
    }
    return;
  }
  send(res, 404, { error: { code: "no_such_route", message: `${method} ${path}` } });
}

export interface MakeServerOptions {
  host?: string;
  port?: number;
  quiet?: boolean;
}

export function makeServer(engine: Engine, options: MakeServerOptions = {}): Server {
  const quiet = options.quiet ?? false;
  const server = createServer((req, res) => {
    handleRequest(engine, req, res).catch((exc) => {
      if (!quiet) {
        console.error(exc);
      }
      if (!res.headersSent) {
        send(res, 500, { error: { code: "internal", message: String(exc) } });
      }
    });
  });
  return server;
}

export function listen(
  server: Server,
  host = "127.0.0.1",
  port = 8765,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        resolve({ host, port });
      } else {
        resolve({ host: address.address, port: address.port });
      }
    });
  });
}
