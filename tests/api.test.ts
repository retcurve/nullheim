/** Exercises the HTTP surface as an external agent or player would. */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, Agent as HttpAgent, type Server } from "node:http";

import { MAX_IMAGE_BODY_BYTES } from "../src/api.ts";
import type { SqliteDb } from "../src/db/sqlite.ts";
import type { Engine } from "../src/engine.ts";
import { MAX_UPLOAD_BYTES } from "../src/image-processing.ts";
import type { Moderator } from "../src/moderation.ts";
import { permissiveModerator } from "../src/moderation/permissive.ts";
import { listen, makeServer } from "../src/node-server.ts";
import { GENRES, MOODS, SIZES } from "../src/theme.ts";
import { interaction, makeEngine, makePng, sector, obj } from "./testing.ts";

interface Ctx {
  base: string;
  server: Server;
}

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  options: { body?: unknown; token?: string; rawBody?: string; accept?: string | null } = {},
): Promise<{ status: number; payload: any }> {
  const headers: Record<string, string> = {};
  let data: string | undefined;
  if (options.body !== undefined) {
    data = JSON.stringify(options.body);
  } else if (options.rawBody !== undefined) {
    data = options.rawBody;
  }
  if (data !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.accept !== undefined && options.accept !== null) {
    headers["Accept"] = options.accept;
  } else if (options.accept === undefined) {
    headers["Accept"] = "application/json";
  }
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const response = await fetch(
    `${ctx.base}${path}`,
    data === undefined ? { method, headers } : { method, headers, body: data },
  );
  const payload = await response.json();
  return { status: response.status, payload };
}

async function callText(
  ctx: Ctx,
  method: string,
  path: string,
  accept = "*/*",
): Promise<{ status: number; contentType: string; text: string }> {
  const response = await fetch(`${ctx.base}${path}`, { method, headers: { Accept: accept } });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text };
}

/** Posts a raw binary body directly, for `POST /v1/images`. */
async function callBinary(
  ctx: Ctx,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  token?: string,
): Promise<{ status: number; contentType: string; payload: any }> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(`${ctx.base}${path}`, { method: "POST", headers, body: bytes });
  const responseContentType = response.headers.get("content-type") ?? "";
  const payload = responseContentType.includes("application/json")
    ? await response.json()
    : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, contentType: responseContentType, payload };
}

async function newAgent(ctx: Ctx, handle = "tester"): Promise<string> {
  const { status, payload } = await call(ctx, "POST", "/v1/agents/register", {
    body: { handle },
  });
  assert.equal(status, 201);
  return payload.token;
}

async function newClaim(ctx: Ctx, token: string): Promise<any> {
  const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
  assert.equal(status, 201);
  return payload;
}

async function settle(
  ctx: Ctx,
  name = "tester",
  overrides: Record<string, unknown> = {},
): Promise<{ token: string; coordinate: [number, number] }> {
  const token = await newAgent(ctx, name);
  const context = await newClaim(ctx, token);
  const claimId = context.claim.claim_id;
  const { status } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
    body: { ...sector(context.coordinate, overrides), finalise: true },
    token,
  });
  assert.equal(status, 201);
  return { token, coordinate: context.coordinate };
}

/** Registers an agent and opens a claim, returning the token and claim. */
async function newUploader(ctx: Ctx, handle = "uploader"): Promise<{ token: string; claim: any }> {
  const token = await newAgent(ctx, handle);
  return { token, claim: await newClaim(ctx, token) };
}

async function sectorIdFor(ctx: Ctx, token: string, index = 0): Promise<string> {
  const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
  return payload.sectors[index].sector_id;
}

type CtxOptions = {
  cooldownSeconds?: number;
  leaseSeconds?: number;
  claimsPerHour?: number;
  registrationsPerHour?: number;
  moderator?: Moderator;
};

async function makeCtx(
  options: CtxOptions = {},
): Promise<{ ctx: Ctx; engine: Engine; db: SqliteDb }> {
  const { engine, db } = await makeEngine(options);
  const server = makeServer(engine, { quiet: true });
  return { ctx: { base: "", server }, engine, db };
}

let current: { ctx: Ctx; engine: Engine; db: SqliteDb } | null = null;

async function setup(options: CtxOptions = {}): Promise<Ctx> {
  current = await makeCtx(options);
  const address = await listen(current.ctx.server, "127.0.0.1", 0);
  current.ctx.base = `http://${address.host}:${address.port}`;
  return current.ctx;
}

function teardown(): Promise<void> {
  return new Promise((resolve) => {
    if (current === null) {
      resolve();
      return;
    }
    current.db.close();
    current.ctx.server.close(() => resolve());
    current = null;
  });
}

describe("public endpoints", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("root serves prose to whoever just turned up", async () => {
    const { status, contentType, text } = await callText(ctx, "GET", "/");
    assert.equal(status, 200);
    assert.ok(contentType.includes("text/plain"));
    assert.ok(text.startsWith("# Nullheim"));
  });

  test("root teaches the three texts, not just the endpoints", async () => {
    const { text } = await callText(ctx, "GET", "/");
    for (const taught of ["short_description", "long_description", "adjacent sector"]) {
      assert.ok(text.includes(taught), taught);
    }
  });

  test("a browser accept header gets the prose wrapped in html, with a /enter note first", async () => {
    const { contentType, text } = await callText(
      ctx,
      "GET",
      "/",
      "text/html,application/xhtml+xml,*/*",
    );
    assert.ok(contentType.includes("text/html"));
    const noteIndex = text.indexOf("/enter");
    const docIndex = text.indexOf("# Nullheim");
    assert.ok(noteIndex >= 0, "note");
    assert.ok(docIndex >= 0, "doc");
    assert.ok(noteIndex < docIndex, "note comes before the document");
  });

  test("root lists every endpoint, each with a summary", async () => {
    const { status, payload } = await call(ctx, "GET", "/");
    assert.equal(status, 200);
    const reference = payload.full_endpoint_reference;
    const paths = new Set(reference.map((e: any) => e.path));
    assert.ok(paths.has("/v1/spec"));
    assert.ok(paths.has("/v1/agents/register"));
    const methods = new Set(reference.map((e: any) => `${e.method} ${e.path}`));
    assert.ok(methods.has("POST /v1/claims"));
    for (const endpoint of reference) {
      assert.ok(endpoint.summary);
    }
  });

  test("root walks an agent through the whole lifecycle", async () => {
    const { status, payload } = await call(ctx, "GET", "/");
    assert.equal(status, 200);
    const steps = payload.getting_started;
    assert.deepEqual(
      steps.map((s: any) => s.step),
      steps.map((_: any, i: number) => i + 1),
    );
    const requests = new Set(
      steps.filter((s: any) => s.request).map((s: any) => `${s.request.method} ${s.request.path}`),
    );
    assert.ok(requests.has("POST /v1/agents/register"));
    assert.ok(requests.has("POST /v1/claims"));
    assert.ok(requests.has("POST /v1/claims/{claim_id}/sector"));
    assert.ok(requests.has("GET /v1/agents/me"));
    assert.ok(requests.has("POST /v1/objects"));
    for (const step of steps) {
      assert.ok(step.do);
    }
  });

  test("health", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/health");
    assert.equal(status, 200);
    assert.equal(payload.status, "ok");
  });

  test("spec carries both schemas and both prompts", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/spec");
    assert.equal(status, 200);
    assert.ok(payload.sector_fields.includes("short_description"));
    assert.ok(payload.object_fields.includes("parent_id"));
    assert.deepEqual(payload.directions, ["north", "south", "east", "west"]);
    assert.ok(payload.prompts.sector_architect.includes("Sector Architect"));
    assert.ok(payload.prompts.object_artisan.includes("Object Artisan"));
  });

  test("reading a sector gives the player's view", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/sectors/0/0");
    assert.equal(status, 200);
    assert.equal(payload.title, "The Grey Expanse");
    assert.ok("description" in payload);
    assert.deepEqual(payload.exits, []);
  });

  test("a new neighbour creates exits on both sides", async () => {
    const { coordinate } = await settle(ctx, "tester", { title: "Somewhere Else" });
    const { payload: origin } = await call(ctx, "GET", "/v1/sectors/0/0");
    const { payload: theirs } = await call(ctx, "GET", `/v1/sectors/${coordinate[0]}/${coordinate[1]}`);

    assert.equal(origin.exits.length, 1);
    assert.equal(origin.exits[0].name, "Somewhere Else");
    assert.equal(theirs.exits.length, 1);
    assert.equal(theirs.exits[0].name, "The Grey Expanse");
  });

  test("reading an empty coordinate is a 404", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/sectors/0/9");
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_sector");
  });

  test("negative coordinates route correctly", async () => {
    const { status } = await call(ctx, "GET", "/v1/sectors/-1/-1");
    assert.equal(status, 404);
  });

  test("reading a missing object is a 404", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/objects/obj_nope");
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_object");
  });

  test("map reports sectors and stats", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/map");
    assert.equal(status, 200);
    assert.equal(payload.sectors.length, 1);
    assert.equal(payload.sectors[0].agent_id, "agent_genesis");
    assert.equal(payload.stats.sectors, 1);

    await settle(ctx, "tester");
    const { payload: after } = await call(ctx, "GET", "/v1/map");
    assert.equal(after.sectors.length, 2);
    assert.equal(after.stats.sectors, 2);
  });

  test("unknown route", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/nonsense");
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_route");
  });

  test("a 404 points a stale caller at the current contract", async () => {
    // Covers a route that used to exist (a saved call from before it was
    // removed) as well as one that never did.
    const { payload } = await call(ctx, "GET", "/v1/claims/claim_x/theme");
    assert.match(payload.error.message, /GET \//);
    assert.match(payload.error.message, /GET \/v1\/spec/);
  });
});

describe("registration", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("a handle is required", async () => {
    const { status, payload } = await call(ctx, "POST", "/v1/agents/register", { body: {} });
    assert.equal(status, 400);
    assert.equal(payload.error.code, "handle_required");
  });

  test("a blank handle is refused the same way as a missing one", async () => {
    const { status, payload } = await call(ctx, "POST", "/v1/agents/register", {
      body: { handle: "   " },
    });
    assert.equal(status, 400);
    assert.equal(payload.error.code, "handle_required");
  });

  test("a handle already taken is refused", async () => {
    await newAgent(ctx, "duplicate");
    const { status, payload } = await call(ctx, "POST", "/v1/agents/register", {
      body: { handle: "duplicate" },
    });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "handle_taken");
  });

  test("two different handles both register fine", async () => {
    const first = await newAgent(ctx, "castellan");
    const second = await newAgent(ctx, "wayfarer");
    assert.notEqual(first, second);
  });
});

describe("auth", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("claiming without a token is refused", async () => {
    const { status, payload } = await call(ctx, "POST", "/v1/claims");
    assert.equal(status, 401);
    assert.equal(payload.error.code, "unauthorised");
  });

  test("a bogus token is refused", async () => {
    const { status } = await call(ctx, "POST", "/v1/claims", { token: "not-a-real-token" });
    assert.equal(status, 401);
  });

  test("a token still works after the sector is baked", async () => {
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(status, 200);
    assert.ok(payload.can_create_object);
    assert.ok(payload.can_claim_sector);
  });

  test("the object prompt arrives with the standing that says it can be used", async () => {
    const { token } = await settle(ctx);
    const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.ok(payload.can_create_object);
    assert.ok(payload.prompt.includes("Object Artisan"));
    assert.ok(!payload.prompt.includes("{{"));
    assert.ok(payload.prompt.includes(payload.sectors[0].sector_id));
    assert.ok(payload.prompt.includes("0 objects"));
  });

  test("one agent cannot read another's claim", async () => {
    const first = await newAgent(ctx, "first");
    const context = await newClaim(ctx, first);
    const second = await newAgent(ctx, "second");
    await newClaim(ctx, second);

    const { status, payload } = await call(
      ctx,
      "GET",
      `/v1/claims/${context.claim.claim_id}`,
      { token: second },
    );
    assert.equal(status, 403);
    assert.equal(payload.error.code, "not_your_claim");
  });
});

describe("claim flow", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("a claim returns a coordinate and a prompt and nothing else", async () => {
    const context = await newClaim(ctx, await newAgent(ctx));
    assert.deepEqual(new Set(Object.keys(context)), new Set(["claim", "coordinate", "world_sectors", "prompt"]));
    assert.ok(context.prompt.includes("Sector Architect"));
    assert.ok(context.prompt.includes(`[${context.coordinate[0]}, ${context.coordinate[1]}]`));
  });

  test("a claim carries its genre, size and mood, stable across calls", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    assert.ok((GENRES as readonly string[]).includes(context.claim.genre));
    assert.ok((SIZES as readonly string[]).includes(context.claim.size));
    assert.ok((MOODS as readonly string[]).includes(context.claim.mood));

    const first = await call(ctx, "GET", `/v1/claims/${claimId}`, { token });
    assert.equal(first.status, 200);
    assert.equal(first.payload.claim.genre, context.claim.genre);
    assert.equal(first.payload.claim.size, context.claim.size);
    assert.equal(first.payload.claim.mood, context.claim.mood);

    const second = await call(ctx, "GET", `/v1/claims/${claimId}`, { token });
    assert.equal(second.payload.claim.genre, first.payload.claim.genre);
    assert.equal(second.payload.claim.size, first.payload.claim.size);
    assert.equal(second.payload.claim.mood, first.payload.claim.mood);
  });

  test("a claim belongs to the claiming agent only", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);

    const { status } = await call(ctx, "GET", `/v1/claims/${context.claim.claim_id}`, {
      token: await newAgent(ctx, "other"),
    });
    assert.equal(status, 403);
  });

  test("the theme endpoint is gone", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);

    const { status } = await call(ctx, "GET", `/v1/claims/${context.claim.claim_id}/theme`, {
      token,
    });
    assert.equal(status, 404);
  });

  test("the claim payload leaks nothing about neighbours", async () => {
    await settle(ctx, "neighbour", { title: "The Tell-Tale Orangery" });
    const context = await newClaim(ctx, await newAgent(ctx, "next"));
    const blob = JSON.stringify(context);
    assert.ok(!blob.includes("Tell-Tale"));
    assert.ok(!blob.includes("The Grey Expanse"));
  });

  test("a rejected submission returns 422 and structured errors", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: { ...sector([99, 99], { title: "" }), finalise: true },
      token,
    });
    assert.equal(status, 422);
    assert.equal(payload.ok, false);
    for (const error of payload.errors) {
      assert.ok("code" in error && "path" in error && "message" in error);
    }
  });

  test("a rejection leaves the lease usable", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: { ...sector([99, 99]), finalise: true },
      token,
    });
    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: { ...sector(context.coordinate), finalise: true },
      token,
    });
    assert.equal(status, 201);
    assert.equal(payload.status, "baked");
  });

  test("resubmitting after baking is refused", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;
    await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: { ...sector(context.coordinate), finalise: true },
      token,
    });

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: { ...sector(context.coordinate), finalise: true },
      token,
    });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "claim_not_active");
  });

  test("submitting without finalise saves a draft instead of baking", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;
    const draft = sector(context.coordinate, { title: "A Draft Place" });

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: draft,
      token,
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "draft");
    assert.deepEqual(payload.draft, draft);
    assert.deepEqual(payload.errors, []);
    assert.match(payload.prompt, /spirit/);
    assert.match(payload.prompt, /"finalise": true/);

    const { payload: view } = await call(ctx, "GET", `/v1/sectors/${context.coordinate[0]}/${context.coordinate[1]}`);
    assert.equal(view.error.code, "no_such_sector");
  });

  test("a draft may be resubmitted any number of times without spending attempts", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    for (let i = 0; i < 5; i += 1) {
      const { status } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
        body: sector(context.coordinate, { title: `Draft ${i}` }),
        token,
      });
      assert.equal(status, 200);
    }

    const { payload: claim } = await call(ctx, "GET", `/v1/claims/${claimId}`, { token });
    assert.equal(claim.claim.attempts, 0);
    assert.equal(claim.claim.status, "open");
    assert.equal(claim.claim.draft.title, "Draft 4");

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: { ...sector(context.coordinate), finalise: true },
      token,
    });
    assert.equal(status, 201);
    assert.equal(payload.status, "baked");
  });

  test("an invalid draft is still saved, with its errors attached, not rejected", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: sector(context.coordinate, { title: "" }),
      token,
    });
    assert.equal(status, 200);
    assert.equal(payload.status, "draft");
    assert.ok(payload.errors.some((e: any) => e.code === "empty_text"));

    const { payload: claim } = await call(ctx, "GET", `/v1/claims/${claimId}`, { token });
    assert.ok(claim.claim.draft !== null);
    assert.equal(claim.claim.status, "open");
  });

  test("holding a claim blocks a second one", async () => {
    const token = await newAgent(ctx);
    await newClaim(ctx, token);
    const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "claim_in_progress");
  });

  test("releasing a claim returns the sector", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    const { status, payload } = await call(ctx, "DELETE", `/v1/claims/${claimId}`, { token });
    assert.equal(status, 200);
    assert.equal(payload.status, "released");

    const frontier = await current!.engine.registry.frontier();
    assert.ok(
      frontier.some(
        (c) => c.x === context.coordinate[0] && c.y === context.coordinate[1],
      ),
    );
  });

  test("a fully leased frontier is a 409", async () => {
    for (let i = 0; i < 4; i += 1) {
      await newClaim(ctx, await newAgent(ctx, `a${i}`));
    }
    const { status, payload } = await call(ctx, "POST", "/v1/claims", {
      token: await newAgent(ctx, "extra"),
    });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "frontier_busy");
  });

});

describe("expired lease", () => {
  test("submitting against an expired lease is a 409", async () => {
    const ctx = await setup({ leaseSeconds: 0 });
    try {
      const token = await newAgent(ctx);
      const context = await newClaim(ctx, token);
      const claimId = context.claim.claim_id;
      const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
        body: sector(context.coordinate),
        token,
      });
      assert.equal(status, 409);
      assert.equal(payload.error.code, "claim_not_active");
    } finally {
      await teardown();
    }
  });
});

describe("objects", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("an agent with no sector gets 409, not 429", async () => {
    const token = await newAgent(ctx);
    const { status, payload } = await call(ctx, "POST", "/v1/objects", {
      body: obj("sec_whatever"),
      token,
    });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "sector_required");
  });

  test("placing an object and seeing it as a player", async () => {
    const { token, coordinate } = await settle(ctx);
    const { status, payload: result } = await call(ctx, "POST", "/v1/objects", {
      body: obj(await sectorIdFor(ctx, token), { title: "Brass Can", description: "Dented." }),
      token,
    });
    assert.equal(status, 201);
    const objectId = result.object.object_id;

    const { payload: view } = await call(ctx, "GET", `/v1/sectors/${coordinate[0]}/${coordinate[1]}`);
    assert.deepEqual(
      view.things_you_can_see.map((t: any) => t.title),
      ["Brass Can"],
    );

    const { payload: detail } = await call(ctx, "GET", `/v1/objects/${objectId}`);
    assert.equal(detail.description, "Dented.");
  });

  test("an object may hang on another", async () => {
    const { token, coordinate } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);
    const { payload: first } = await call(ctx, "POST", "/v1/objects", {
      body: obj(sectorId, { title: "Can" }),
      token,
    });
    const parentId = first.object.object_id;

    const { status } = await call(ctx, "POST", "/v1/objects", {
      body: obj(parentId, { title: "Key" }),
      token,
    });
    assert.equal(status, 201);

    const { payload: view } = await call(ctx, "GET", `/v1/sectors/${coordinate[0]}/${coordinate[1]}`);
    assert.deepEqual(
      view.things_you_can_see.map((t: any) => t.title),
      ["Can"],
    );
    const { payload: detail } = await call(ctx, "GET", `/v1/objects/${parentId}`);
    assert.deepEqual(
      detail.things_you_can_see.map((t: any) => t.title),
      ["Key"],
    );
  });

  test("another agent's object is not a valid parent", async () => {
    const { token: firstToken } = await settle(ctx, "first");
    const { payload: theirs } = await call(ctx, "POST", "/v1/objects", {
      body: obj(await sectorIdFor(ctx, firstToken), { title: "Theirs" }),
      token: firstToken,
    });
    const { token: secondToken } = await settle(ctx, "second");

    const { status, payload } = await call(ctx, "POST", "/v1/objects", {
      body: obj(theirs.object.object_id),
      token: secondToken,
    });
    assert.equal(status, 422);
    assert.deepEqual(new Set(payload.errors.map((e: any) => e.code)), new Set(["no_such_parent"]));
  });

  test("agents/me exposes a per-sector object count, not the tree", async () => {
    const { token } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);
    const { payload: first } = await call(ctx, "POST", "/v1/objects", {
      body: obj(sectorId, { title: "Can" }),
      token,
    });
    await call(ctx, "POST", "/v1/objects", {
      body: obj(first.object.object_id, { title: "Key" }),
      token,
    });

    const { status, payload: me } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(status, 200);
    assert.equal(me.sectors.length, 1);
    assert.equal(me.sectors[0].sector_id, sectorId);
    assert.equal(me.sectors[0].object_count, 2);
    assert.equal(me.sectors[0].objects, undefined);
    assert.equal(me.sectors[0].title, undefined);

    const { payload: detail } = await call(ctx, "GET", `/v1/agents/sector/${sectorId}`, {
      token,
    });
    assert.equal(detail.objects[0].title, "Can");
    assert.equal(detail.objects[0].contains[0].title, "Key");
  });

  test("use_text rides on the object and defaults to null", async () => {
    const { token } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);
    const { payload: withText } = await call(ctx, "POST", "/v1/objects", {
      body: obj(sectorId, { title: "Lever", use_text: "It creaks, then gives." }),
      token,
    });
    const { payload: withoutText } = await call(ctx, "POST", "/v1/objects", {
      body: obj(sectorId, { title: "Statue" }),
      token,
    });

    const { payload: leverView } = await call(ctx, "GET", `/v1/objects/${withText.object.object_id}`);
    assert.equal(leverView.use_text, "It creaks, then gives.");
    const { payload: statueView } = await call(ctx, "GET", `/v1/objects/${withoutText.object.object_id}`);
    assert.equal(statueView.use_text, null);
  });
});

describe("interactions", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  async function twoObjects(token: string): Promise<[string, string]> {
    const sectorId = await sectorIdFor(ctx, token);
    const { payload: a } = await call(ctx, "POST", "/v1/objects", { body: obj(sectorId, { title: "Rope" }), token });
    const { payload: b } = await call(ctx, "POST", "/v1/objects", { body: obj(sectorId, { title: "Hook" }), token });
    return [a.object.object_id, b.object.object_id];
  }

  test("writing and reading an interaction, in either order", async () => {
    const { token } = await settle(ctx);
    const [a, b] = await twoObjects(token);

    const { status, payload } = await call(ctx, "POST", "/v1/interactions", {
      body: interaction(a, b, { text: "Tied fast." }),
      token,
    });
    assert.equal(status, 201);
    assert.equal(payload.interaction.text, "Tied fast.");

    const { status: forward, payload: forwardView } = await call(ctx, "GET", `/v1/interactions/${a}/${b}`);
    assert.equal(forward, 200);
    assert.equal(forwardView.text, "Tied fast.");

    const { status: reverse, payload: reverseView } = await call(ctx, "GET", `/v1/interactions/${b}/${a}`);
    assert.equal(reverse, 200);
    assert.equal(reverseView.text, "Tied fast.");
  });

  test("no interaction between a pair is a 404, not an error about the objects", async () => {
    const { token } = await settle(ctx);
    const [a, b] = await twoObjects(token);
    const { status, payload } = await call(ctx, "GET", `/v1/interactions/${a}/${b}`);
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_interaction");
  });

  test("a second interaction for the same pair is refused", async () => {
    const { token } = await settle(ctx);
    const [a, b] = await twoObjects(token);
    await call(ctx, "POST", "/v1/interactions", { body: interaction(a, b), token });

    const { status, payload } = await call(ctx, "POST", "/v1/interactions", {
      body: interaction(a, b, { text: "Something else." }),
      token,
    });
    assert.equal(status, 422);
    assert.deepEqual(new Set(payload.errors.map((e: any) => e.code)), new Set(["interaction_exists"]));
  });

  test("an object in another agent's sector is not a valid interaction partner", async () => {
    const { token: firstToken } = await settle(ctx, "first");
    const [a] = await twoObjects(firstToken);
    const { token: secondToken } = await settle(ctx, "second");
    const [, theirsB] = await twoObjects(secondToken);

    const { status, payload } = await call(ctx, "POST", "/v1/interactions", {
      body: interaction(a, theirsB),
      token: secondToken,
    });
    assert.equal(status, 422);
    assert.deepEqual(new Set(payload.errors.map((e: any) => e.code)), new Set(["no_such_object"]));
  });

  test("an agent with no sector gets 409, not 422", async () => {
    const token = await newAgent(ctx);
    const { status, payload } = await call(ctx, "POST", "/v1/interactions", {
      body: interaction("obj_a", "obj_b"),
      token,
    });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "sector_required");
  });

});

describe("security headers", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("every API response carries them", async () => {
    const response = await fetch(`${ctx.base}/v1/health`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });

  test("uploaded image bytes are marked not to be sniffed", async () => {
    const { token } = await newUploader(ctx);
    const { payload } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    const response = await fetch(`${ctx.base}${payload.url}`);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  test("the player frontend gets a policy that confines it to this origin", async () => {
    const response = await fetch(`${ctx.base}/enter/`);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
      assert.ok(csp.includes(directive), directive);
    }
    assert.doesNotMatch(csp, /unsafe-/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});

describe("images", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("uploading requires auth", async () => {
    const { status } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png");
    assert.equal(status, 401);
  });

  test("uploading requires a live claim, not just a token", async () => {
    const token = await newAgent(ctx);
    const { status, payload } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    assert.equal(status, 409);
    assert.equal(payload.error.code, "claim_required");
  });

  test("a claim pays for exactly one image", async () => {
    const { token } = await newUploader(ctx);
    const { status: first } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    assert.equal(first, 201);

    const { status, payload } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    assert.equal(status, 409);
    assert.equal(payload.error.code, "image_already_uploaded");
  });

  test("a refused upload does not spend the claim's image", async () => {
    const { token } = await newUploader(ctx);
    const { status: refused } = await callBinary(
      ctx,
      "/v1/images",
      new TextEncoder().encode("not an image"),
      "image/png",
      token,
    );
    assert.equal(refused, 422);

    const { status } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    assert.equal(status, 201);
  });

  test("the claim says whether its image is spent", async () => {
    const { token, claim } = await newUploader(ctx);
    const path = `/v1/claims/${claim.claim.claim_id}`;
    const { payload: before } = await call(ctx, "GET", path, { token });
    assert.equal(before.claim.image_uploaded, false);

    await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    const { payload: after } = await call(ctx, "GET", path, { token });
    assert.equal(after.claim.image_uploaded, true);
  });

  test("a new claim earns a new image", async () => {
    const { token, claim } = await newUploader(ctx);
    await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    await call(ctx, "DELETE", `/v1/claims/${claim.claim.claim_id}`, { token });
    await newClaim(ctx, token);

    const { status } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    assert.equal(status, 201);
  });

  test("a wide upload comes back resized, compressed, and fetchable", async () => {
    const { token } = await newUploader(ctx);
    const { status, payload: uploaded } = await callBinary(
      ctx,
      "/v1/images",
      makePng(1600, 900),
      "image/png",
      token,
    );
    assert.equal(status, 201);
    assert.match(uploaded.url, /^\/v1\/images\/[\w-]+$/);
    assert.equal(uploaded.state, "published");

    const response = await fetch(`${ctx.base}${uploaded.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = new Uint8Array(await response.arrayBuffer());
    assert.ok(body.length > 0);
  });

  test("the json body shape works too, for callers that can only send JSON", async () => {
    const { token } = await newUploader(ctx);
    const png = makePng(10, 10);
    const { status, payload } = await call(ctx, "POST", "/v1/images", {
      body: { image_base64: Buffer.from(png).toString("base64") },
      token,
    });
    assert.equal(status, 201);
    assert.match(payload.url, /^\/v1\/images\/[\w-]+$/);
  });

  test("not actually an image is refused regardless of the declared type", async () => {
    const { token } = await newUploader(ctx);
    const { status, payload } = await callBinary(
      ctx,
      "/v1/images",
      new TextEncoder().encode("not an image"),
      "image/png",
      token,
    );
    assert.equal(status, 422);
    assert.equal(payload.error.code, "unsupported_image");
  });

  test("an upload past the image cap is refused, naming the cap it broke", async () => {
    const { token } = await newUploader(ctx);
    const tooLarge = new Uint8Array(5_000_001);
    const { status, payload } = await callBinary(ctx, "/v1/images", tooLarge, "image/png", token);
    assert.equal(status, 422);
    assert.equal(payload.error.code, "unsupported_image");
    assert.match(payload.error.message, /5000000/);
  });

  test("a body past the transport cap never reaches the pipeline at all", async () => {
    const { token } = await newUploader(ctx);
    const tooLarge = new Uint8Array(MAX_IMAGE_BODY_BYTES + 1);
    const { status, payload } = await callBinary(ctx, "/v1/images", tooLarge, "image/png", token);
    assert.equal(status, 413);
    assert.equal(payload.error.code, "payload_too_large");
  });

  test("a base64 body of a legal image is not refused for its encoding overhead", async () => {
    const { token } = await newUploader(ctx);
    const png = makePng(40, 40);
    const encoded = Buffer.from(png).toString("base64");
    assert.ok(Math.ceil(5_000_000 / 3) * 4 > MAX_UPLOAD_BYTES);
    const { status } = await call(ctx, "POST", "/v1/images", {
      body: { image_base64: encoded },
      token,
    });
    assert.equal(status, 201);
  });

  test("a fetched url can be attached to a sector at creation", async () => {
    const { token, claim } = await newUploader(ctx);
    const { payload: uploaded } = await callBinary(ctx, "/v1/images", makePng(20, 20), "image/png", token);

    const { status, payload: result } = await call(ctx, "POST", `/v1/claims/${claim.claim.claim_id}/sector`, {
      body: { ...sector(claim.coordinate, { image: uploaded.url }), finalise: true },
      token,
    });
    assert.equal(status, 201);
    assert.equal(result.sector.sector.image, uploaded.url);

    const { payload: view } = await call(ctx, "GET", `/v1/sectors/${claim.coordinate[0]}/${claim.coordinate[1]}`);
    assert.equal(view.image, uploaded.url);
  });

  test("cache lifetime follows whether the image is permanent", async () => {
    const { token, claim } = await newUploader(ctx);
    const { payload: uploaded } = await callBinary(ctx, "/v1/images", makePng(20, 20), "image/png", token);

    const before = await fetch(`${ctx.base}${uploaded.url}`);
    assert.equal(before.headers.get("cache-control"), "no-store");

    const { status } = await call(ctx, "POST", `/v1/claims/${claim.claim.claim_id}/sector`, {
      body: { ...sector(claim.coordinate, { image: uploaded.url }), finalise: true },
      token,
    });
    assert.equal(status, 201);

    const after = await fetch(`${ctx.base}${uploaded.url}`);
    assert.equal(after.headers.get("cache-control"), "public, max-age=31536000, immutable");
  });

  test("objects carry no image field: passing one is refused as unrecognised", async () => {
    const { token } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);
    const { payload: uploaded } = await callBinary(
      ctx,
      "/v1/images",
      makePng(20, 20),
      "image/png",
      (await newUploader(ctx, "image-holder")).token,
    );

    const { status, payload } = await call(ctx, "POST", "/v1/objects", {
      body: obj(sectorId, { image: uploaded.url }),
      token,
    });
    assert.equal(status, 422);
    assert.deepEqual(new Set(payload.errors.map((e: any) => e.code)), new Set(["unknown_field"]));
  });

  test("an arbitrary external url is refused structurally, never fetched", async () => {
    const token = await newAgent(ctx);
    const claim = await newClaim(ctx, token);
    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claim.claim.claim_id}/sector`, {
      body: { ...sector(claim.coordinate, { image: "https://example.com/evil.png" }), finalise: true },
      token,
    });
    assert.equal(status, 422);
    assert.deepEqual(new Set(payload.errors.map((e: any) => e.code)), new Set(["invalid_image"]));
  });
});

describe("image moderation", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0, moderator: permissiveModerator("unsure") });
  });
  afterEach(teardown);

  test("a pending image 404s — never 403, so the endpoint can't confirm it exists", async () => {
    const { token } = await newUploader(ctx);
    const { payload: uploaded } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);

    const response = await fetch(`${ctx.base}${uploaded.url}`);
    assert.equal(response.status, 404);
  });

  test("the upload response itself tells the uploader it's pending, unlike GET", async () => {
    const { token } = await newUploader(ctx);
    const { status, payload: uploaded } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);
    assert.equal(status, 201);
    assert.equal(uploaded.state, "pending");
    assert.match(uploaded.note, /moderation/);
  });

  test("a sector baked against a pending image shows no image until a human approves it", async () => {
    const { token, claim } = await newUploader(ctx);
    const { payload: uploaded } = await callBinary(ctx, "/v1/images", makePng(10, 10), "image/png", token);

    const { status } = await call(ctx, "POST", `/v1/claims/${claim.claim.claim_id}/sector`, {
      body: { ...sector(claim.coordinate, { image: uploaded.url }), finalise: true },
      token,
    });
    assert.equal(status, 201);

    const path = `/v1/sectors/${claim.coordinate[0]}/${claim.coordinate[1]}`;
    const { payload: before } = await call(ctx, "GET", path);
    assert.equal(before.image, null);

    const key = uploaded.url.slice("/v1/images/".length);
    assert.equal(await current!.engine.store.approveImage(key), true);

    const { payload: after } = await call(ctx, "GET", path);
    assert.equal(after.image, uploaded.url);
    const response = await fetch(`${ctx.base}${uploaded.url}`);
    assert.equal(response.status, 200);
  });
});

describe("the world-wide claim rate", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0, claimsPerHour: 2 });
  });
  afterEach(teardown);

  test("the cap counts claims across agents, not per agent", async () => {
    await newClaim(ctx, await newAgent(ctx, "one"));
    await newClaim(ctx, await newAgent(ctx, "two"));

    const { status, payload } = await call(ctx, "POST", "/v1/claims", {
      token: await newAgent(ctx, "three"),
    });
    assert.equal(status, 429);
    assert.equal(payload.error.code, "claim_rate_limited");
    assert.equal(payload.claims_per_hour, 2);
    assert.ok(payload.retry_after > 0);
  });

  test("a released claim still spent its slot", async () => {
    const token = await newAgent(ctx, "churner");
    const first = await newClaim(ctx, token);
    await call(ctx, "DELETE", `/v1/claims/${first.claim.claim_id}`, { token });
    await newClaim(ctx, token);

    const { status } = await call(ctx, "POST", "/v1/claims", {
      token: await newAgent(ctx, "late"),
    });
    assert.equal(status, 429);
  });

  test("zero disables the cap", async () => {
    await teardown();
    ctx = await setup({ cooldownSeconds: 0, claimsPerHour: 0 });
    for (let i = 0; i < 4; i += 1) {
      const { status } = await call(ctx, "POST", "/v1/claims", {
        token: await newAgent(ctx, `a${i}`),
      });
      assert.equal(status, 201);
    }
  });

  test("the frontend's own endpoints are never rate limited", async () => {
    await newClaim(ctx, await newAgent(ctx, "one"));
    await newClaim(ctx, await newAgent(ctx, "two"));

    for (let i = 0; i < 12; i += 1) {
      for (const path of ["/v1/sectors/0/0", "/v1/map", "/v1/health"]) {
        const { status } = await call(ctx, "GET", path);
        assert.equal(status, 200, `${path} on pass ${i}`);
      }
    }
  });
});

describe("the world-wide registration rate", () => {
  let ctx: Ctx;
  afterEach(teardown);

  test("registration is capped world-wide, and a fresh token is no way around it", async () => {
    ctx = await setup({ cooldownSeconds: 0, registrationsPerHour: 2 });
    await newAgent(ctx, "one");
    await newAgent(ctx, "two");

    const { status, payload } = await call(ctx, "POST", "/v1/agents/register", {
      body: { handle: "three" },
    });
    assert.equal(status, 429);
    assert.equal(payload.error.code, "registration_rate_limited");
    assert.equal(payload.registrations_per_hour, 2);
    assert.ok(payload.retry_after > 0);
  });

  test("a refused handle still spent its slot", async () => {
    ctx = await setup({ cooldownSeconds: 0, registrationsPerHour: 2 });
    await newAgent(ctx, "taken");
    const { status: collision } = await call(ctx, "POST", "/v1/agents/register", {
      body: { handle: "taken" },
    });
    assert.equal(collision, 409);

    const { status } = await call(ctx, "POST", "/v1/agents/register", {
      body: { handle: "third" },
    });
    assert.equal(status, 429);
  });

  test("zero disables it", async () => {
    ctx = await setup({ cooldownSeconds: 0, registrationsPerHour: 0 });
    for (let i = 0; i < 4; i += 1) {
      await newAgent(ctx, `agent${i}`);
    }
  });
});

describe("multiple sectors", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("a second sector is available immediately, with no objects placed at all", async () => {
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
    assert.equal(status, 201);
    assert.notDeepEqual(payload.coordinate, (await call(ctx, "GET", "/v1/agents/me", { token }))
      .payload.agent.coordinates[0]);
  });

  test("agents/me carries no object debt any more", async () => {
    const { token } = await settle(ctx);
    const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(payload.agent.sectors_owned, 1);
    assert.ok(!("objects_until_next_sector" in payload.agent));
    assert.equal(payload.can_claim_sector, true);
  });

  test("a fresh agent may claim its first sector immediately", async () => {
    const token = await newAgent(ctx, "newcomer");
    const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(payload.agent.sectors_owned, 0);
    assert.equal(payload.can_claim_sector, true);
    assert.deepEqual(payload.sectors, []);
  });

  test("an object lands in whichever held sector parent_id names", async () => {
    const { token } = await settle(ctx);
    const first = await sectorIdFor(ctx, token, 0);
    await call(ctx, "POST", "/v1/objects", { body: obj(first, { title: "T0" }), token });

    const context = await newClaim(ctx, token);
    await call(ctx, "POST", `/v1/claims/${context.claim.claim_id}/sector`, {
      body: { ...sector(context.coordinate), finalise: true },
      token,
    });
    const second = await sectorIdFor(ctx, token, 1);

    const { status, payload } = await call(ctx, "POST", "/v1/objects", {
      body: obj(second, { title: "In The New One" }),
      token,
    });
    assert.equal(status, 201);
    assert.deepEqual(payload.object.coordinate, context.coordinate);

    const { status: backAgain } = await call(ctx, "POST", "/v1/objects", {
      body: obj(first, { title: "Back In The Old One" }),
      token,
    });
    assert.equal(backAgain, 201);
  });
});

describe("cooldown", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 3600 });
  });
  afterEach(teardown);

  test("a fresh sector's cooldown blocks another claim, not furnishing it", async () => {
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
    assert.equal(status, 429);
    assert.equal(payload.error.code, "cooldown");
    assert.ok(payload.agent.cooldown_remaining > 0);
  });

  test("a cooldown refusal and a claim_in_progress refusal are distinguishable", async () => {
    const { token: settled } = await settle(ctx, "settled");
    const holding = await newAgent(ctx, "holding");
    await newClaim(ctx, holding);

    const codes = new Set<string>();
    const statuses = new Set<number>();
    for (const token of [settled, holding]) {
      const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
      statuses.add(status);
      codes.add(payload.error.code);
    }
    assert.deepEqual(codes, new Set(["cooldown", "claim_in_progress"]));
    assert.deepEqual(statuses, new Set([429, 409]));
  });

  test("placing an object is unaffected by the sector cooldown", async () => {
    const { token } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);
    const { status } = await call(ctx, "POST", "/v1/objects", {
      body: obj(sectorId),
      token,
    });
    assert.equal(status, 201);
  });

  test("placing an interaction is unaffected by the sector cooldown", async () => {
    const { token } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);
    const { payload: a } = await call(ctx, "POST", "/v1/objects", { body: obj(sectorId, { title: "Rope" }), token });
    const { payload: b } = await call(ctx, "POST", "/v1/objects", { body: obj(sectorId, { title: "Hook" }), token });
    const { status } = await call(ctx, "POST", "/v1/interactions", {
      body: interaction(a.object.object_id, b.object.object_id),
      token,
    });
    assert.equal(status, 201);
  });

  test("agents/me is never cooldown-gated, and reports the sector clock separately", async () => {
    const { token } = await settle(ctx);
    const { payload: me } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(me.can_create_object, true);
    assert.equal(me.can_claim_sector, false);
    assert.equal(me.cooldown_seconds, 3600);
    assert.ok(me.agent.cooldown_remaining > 0);
    assert.ok(me.prompt.includes("Object Artisan"));
  });

  test("/v1/cooldown is the cheap poll and carries only the sector clock", async () => {
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "GET", "/v1/cooldown", { token });
    assert.equal(status, 200);
    assert.equal(payload.can_claim_sector, false);
    assert.equal(payload.cooldown_seconds, 3600);
    assert.ok(payload.cooldown_remaining > 0);
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["can_claim_sector", "cooldown_remaining", "cooldown_seconds"],
    );
    assert.equal(payload.sectors, undefined);
    assert.equal(payload.prompt, undefined);
  });
});

describe("malformed input", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("a non-JSON body is a 400", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;
    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      rawBody: "{nope",
      token,
    });
    assert.equal(status, 400);
    assert.equal(payload.error.code, "malformed_json");
  });

  test("an oversized body is a 413", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;
    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      rawBody: "x".repeat(200_000),
      token,
    });
    assert.equal(status, 413);
    assert.equal(payload.error.code, "payload_too_large");
  });

  test("a body without Content-Length is bounded", async () => {
    const url = new URL("/v1/claims", ctx.base);
    // Sends a chunked body with no Content-Length header.
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { "Content-Type": "application/json" },
      },
    );
    req.on("error", () => {});
    req.write("x".repeat(200_000));
    req.end();

    const { status, payload } = await call(ctx, "GET", "/v1/health");
    assert.equal(status, 200);
    assert.equal(payload.status, "ok");
  });
});

describe("keep-alive", () => {
  let ctx: Ctx;
  let agent: HttpAgent;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
    agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  });
  afterEach(async () => {
    agent.destroy();
    await teardown();
  });

  function rawRequest(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; text: string }> {
    const url = new URL(path, ctx.base);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          agent,
          headers: body ? { "Content-Type": "application/json" } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  test("a body the handler ignores is still drained", async () => {
    const first = await rawRequest("POST", "/v1/claims", JSON.stringify({ junk: "x".repeat(500) }));
    assert.equal(first.status, 401);

    const second = await rawRequest("GET", "/v1/health");
    assert.equal(second.status, 200);
    assert.equal(JSON.parse(second.text).status, "ok");
  });

  test("the connection is reused rather than reopened", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { status } = await rawRequest("GET", "/v1/health");
      assert.equal(status, 200);
    }
    assert.equal(agent.sockets[Object.keys(agent.sockets)[0] ?? ""]?.length ?? 0, 0);
    assert.ok((agent.freeSockets[Object.keys(agent.freeSockets)[0] ?? ""]?.length ?? 0) >= 1);
  });
});
