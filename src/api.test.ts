/** The HTTP surface, exercised the way an external agent (or player) would use it. */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, Agent as HttpAgent, type Server } from "node:http";

import type { SqliteDb } from "./db/sqlite.ts";
import type { Engine } from "./engine.ts";
import { listen, makeServer } from "./node-server.ts";
import { makeEngine, sector, obj } from "./testing.ts";

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
    body: sector(context.coordinate, overrides),
    token,
  });
  assert.equal(status, 201);
  return { token, coordinate: context.coordinate };
}

async function sectorIdFor(ctx: Ctx, token: string, index = 0): Promise<string> {
  const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
  return payload.sectors[index].sector_id;
}

type CtxOptions = { cooldownSeconds?: number; leaseSeconds?: number; claimsPerHour?: number };

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
    // The craft, not only the choreography — this is the whole point of /.
    const { text } = await callText(ctx, "GET", "/");
    for (const taught of ["short_description", "long_description", "Exits are derived"]) {
      assert.ok(text.includes(taught), taught);
    }
  });

  test("a browser accept header still gets the prose", async () => {
    const { contentType } = await callText(
      ctx,
      "GET",
      "/",
      "text/html,application/xhtml+xml,*/*",
    );
    assert.ok(contentType.includes("text/plain"));
  });

  test("root lists every endpoint for an agent with no repo access", async () => {
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
    const requests = new Set(steps.map((s: any) => `${s.request.method} ${s.request.path}`));
    assert.ok(requests.has("POST /v1/agents/register"));
    assert.ok(requests.has("POST /v1/claims"));
    assert.ok(requests.has("POST /v1/claims/{claim_id}/validate"));
    assert.ok(requests.has("POST /v1/claims/{claim_id}/sector"));
    assert.ok(requests.has("GET /v1/agents/me"));
    assert.ok(requests.has("POST /v1/objects/validate"));
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
    assert.equal(payload.title, "The Nullpoint");
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
    assert.equal(theirs.exits[0].name, "The Nullpoint");
  });

  test("reading an empty coordinate is a 404", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/sectors/0/9");
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_sector");
  });

  test("negative coordinates route correctly", async () => {
    const { status } = await call(ctx, "GET", "/v1/sectors/-1/-1");
    assert.equal(status, 404); // routed, just empty
  });

  test("reading a missing object is a 404", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/objects/obj_nope");
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_object");
  });

  test("map reports sectors, edges and frontier", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/map");
    assert.equal(status, 200);
    assert.equal(payload.sectors.length, 1);
    assert.equal(payload.frontier.length, 4);
  });

  test("unknown route", async () => {
    const { status, payload } = await call(ctx, "GET", "/v1/nonsense");
    assert.equal(status, 404);
    assert.equal(payload.error.code, "no_such_route");
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
    // Agents are long-lived now — the credential outlives the building.
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(status, 200);
    assert.ok(payload.can_create_object);
    assert.ok(!payload.can_claim_sector);
  });

  test("the object prompt arrives with the standing that says it can be used", async () => {
    // The claim response carries the sector prompt; this is its counterpart for
    // the half of the loop that has no event of its own to ride on.
    const { token } = await settle(ctx);
    const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.ok(payload.can_create_object);
    assert.ok(payload.prompt.includes("Object Artisan"));
    assert.ok(!payload.prompt.includes("{{"));
    assert.ok(payload.prompt.includes(payload.sectors[0].sector_id));
    assert.ok(payload.prompt.includes("nothing yet"));
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

  test("the claim payload leaks nothing about neighbours", async () => {
    await settle(ctx, "neighbour", { title: "The Tell-Tale Orangery" });
    const context = await newClaim(ctx, await newAgent(ctx, "next"));
    const blob = JSON.stringify(context);
    assert.ok(!blob.includes("Tell-Tale"));
    assert.ok(!blob.includes("Nullpoint"));
  });

  test("dry run reports errors without baking", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    let result = await call(ctx, "POST", `/v1/claims/${claimId}/validate`, {
      body: sector(context.coordinate, { title: "" }),
      token,
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, false);
    assert.equal(await current!.engine.store.count(), 1);

    result = await call(ctx, "POST", `/v1/claims/${claimId}/validate`, {
      body: sector(context.coordinate),
      token,
    });
    assert.equal(result.payload.ok, true);
    assert.equal(await current!.engine.store.count(), 1);
  });

  test("a rejected submission returns 422 and structured errors", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: sector([99, 99], { title: "" }),
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

    await call(ctx, "POST", `/v1/claims/${claimId}/sector`, { body: sector([99, 99]), token });
    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: sector(context.coordinate),
      token,
    });
    assert.equal(status, 201);
    assert.equal(payload.status, "baked");
  });

  test("resubmitting after baking is refused", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;
    await call(ctx, "POST", `/v1/claims/${claimId}/sector`, { body: sector(context.coordinate), token });

    const { status, payload } = await call(ctx, "POST", `/v1/claims/${claimId}/sector`, {
      body: sector(context.coordinate),
      token,
    });
    // The token still works, but the claim is spent — the sector is locked.
    assert.equal(status, 409);
    assert.equal(payload.error.code, "claim_not_active");
  });

  test("a settled agent cannot claim again until it has furnished", async () => {
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "sector_locked");
    assert.equal(payload.retryable, false);
  });

  test("holding a claim blocks a second one but is retryable", async () => {
    const token = await newAgent(ctx);
    await newClaim(ctx, token);
    const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "claim_in_progress");
    assert.equal(payload.retryable, true);
  });

  test("releasing a claim returns the sector", async () => {
    const token = await newAgent(ctx);
    const context = await newClaim(ctx, token);
    const claimId = context.claim.claim_id;

    const { status, payload } = await call(ctx, "DELETE", `/v1/claims/${claimId}`, { token });
    assert.equal(status, 200);
    assert.equal(payload.status, "released");

    const { payload: world } = await call(ctx, "GET", "/v1/map");
    assert.ok(
      world.frontier.some(
        (c: [number, number]) => c[0] === context.coordinate[0] && c[1] === context.coordinate[1],
      ),
    );
  });

  test("a fully leased frontier is a retryable 409", async () => {
    for (let i = 0; i < 4; i += 1) {
      await newClaim(ctx, await newAgent(ctx, `a${i}`));
    }
    const { status, payload } = await call(ctx, "POST", "/v1/claims", {
      token: await newAgent(ctx, "extra"),
    });
    assert.equal(status, 409);
    assert.equal(payload.error.code, "frontier_busy");
    assert.equal(payload.retryable, true);
  });

  test("the three claim refusals are distinguishable", async () => {
    // One code for all three would have agents retrying a permanent refusal.
    const { token: settled } = await settle(ctx, "settled");
    const holding = await newAgent(ctx, "holding");
    await newClaim(ctx, holding);

    const codes = new Set<string>();
    for (const token of [settled, holding]) {
      const { payload } = await call(ctx, "POST", "/v1/claims", { token });
      codes.add(payload.error.code);
    }
    assert.deepEqual(codes, new Set(["sector_locked", "claim_in_progress"]));
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
    // No sector is a state error, not a rate limit.
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

  test("the object dry run places nothing", async () => {
    const { token } = await settle(ctx);
    const before = await current!.engine.store.objectCount();
    const { status, payload } = await call(ctx, "POST", "/v1/objects/validate", {
      body: obj(await sectorIdFor(ctx, token)),
      token,
    });
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(await current!.engine.store.objectCount(), before);
  });

  test("agents/me exposes the object tree for choosing a parent", async () => {
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
    const tree = me.sectors[0].objects;
    assert.equal(tree[0].title, "Can");
    assert.equal(tree[0].contains[0].title, "Key");
  });
});

describe("the world-wide claim rate", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0, claimsPerHour: 2 });
  });
  afterEach(teardown);

  test("the cap counts claims across agents, not per agent", async () => {
    // The whole point: a second token is not a way around it.
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
    // Otherwise claim/release in a loop would cost an attacker nothing.
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
    // /enter reads the world through these three and nothing else. Exhaust the
    // claim rate first, then confirm a player is entirely unaffected by it.
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

describe("earning a second sector", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("three objects unlock another claim, over HTTP", async () => {
    const { token } = await settle(ctx);
    const sectorId = await sectorIdFor(ctx, token);

    for (let i = 0; i < 3; i += 1) {
      const { status } = await call(ctx, "POST", "/v1/objects", {
        body: obj(sectorId, { title: `Thing ${i}` }),
        token,
      });
      assert.equal(status, 201);
    }

    const { status, payload } = await call(ctx, "POST", "/v1/claims", { token });
    assert.equal(status, 201);
    assert.notDeepEqual(payload.coordinate, (await call(ctx, "GET", "/v1/agents/me", { token }))
      .payload.agent.coordinates[0]);
  });

  test("agents/me counts down to the next sector", async () => {
    const { token } = await settle(ctx);
    const { payload: before } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(before.agent.sectors_owned, 1);
    assert.equal(before.agent.objects_until_next_sector, 3);
    assert.equal(before.can_claim_sector, false);

    const sectorId = await sectorIdFor(ctx, token);
    for (let i = 0; i < 3; i += 1) {
      await call(ctx, "POST", "/v1/objects", {
        body: obj(sectorId, { title: `Thing ${i}` }),
        token,
      });
    }

    const { payload: after } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(after.agent.objects_until_next_sector, 0);
    assert.equal(after.can_claim_sector, true);
  });

  test("a fresh agent owes nothing for its first sector", async () => {
    const token = await newAgent(ctx, "newcomer");
    const { payload } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(payload.agent.sectors_owned, 0);
    assert.equal(payload.agent.objects_until_next_sector, 0);
    assert.equal(payload.can_claim_sector, true);
    assert.deepEqual(payload.sectors, []);
  });

  test("an object lands in whichever held sector parent_id names", async () => {
    const { token } = await settle(ctx);
    const first = await sectorIdFor(ctx, token, 0);
    for (let i = 0; i < 3; i += 1) {
      await call(ctx, "POST", "/v1/objects", { body: obj(first, { title: `T${i}` }), token });
    }

    const context = await newClaim(ctx, token);
    await call(ctx, "POST", `/v1/claims/${context.claim.claim_id}/sector`, {
      body: sector(context.coordinate),
      token,
    });
    const second = await sectorIdFor(ctx, token, 1);

    const { status, payload } = await call(ctx, "POST", "/v1/objects", {
      body: obj(second, { title: "In The New One" }),
      token,
    });
    assert.equal(status, 201);
    assert.deepEqual(payload.object.coordinate, context.coordinate);

    // And the older sector is still open for business.
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

  test("a fresh sector is on cooldown", async () => {
    const { token } = await settle(ctx);
    const { status, payload } = await call(ctx, "POST", "/v1/objects", {
      body: obj("sec_whatever"),
      token,
    });
    assert.equal(status, 429);
    assert.equal(payload.error.code, "cooldown");
    assert.ok(payload.agent.cooldown_remaining > 0);
  });

  test("agents/me reports the wait", async () => {
    const { token } = await settle(ctx);
    const { payload: me } = await call(ctx, "GET", "/v1/agents/me", { token });
    assert.equal(me.can_create_object, false);
    assert.equal(me.cooldown_seconds, 3600);
    assert.ok(me.agent.cooldown_remaining > 0);
    // This is the endpoint the clock is watched on, so most calls to it are
    // polls that can do nothing with a prompt. They do not carry one.
    assert.equal(me.prompt, undefined);
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
    // Send a body with chunked transfer-encoding (no Content-Length
    // header). The server must not let the chunks array grow without
    // bound — the excess is drained and discarded rather than stored.
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

    // The server must still be alive.
    const { status, payload } = await call(ctx, "GET", "/v1/health");
    assert.equal(status, 200);
    assert.equal(payload.status, "ok");
  });
});

describe("keep-alive", () => {
  // Connection reuse must not be poisoned by a body a handler ignored.
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
    // POST /v1/claims never looks at the body, and this one fails auth before
    // routing anyway. The bytes must not survive into request two.
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
    // maxSockets: 1 forces reuse of the same socket; if the server had closed
    // it, node's agent would have opened a new one silently. Checking the
    // socket count directly is the honest assertion here.
    assert.equal(agent.sockets[Object.keys(agent.sockets)[0] ?? ""]?.length ?? 0, 0);
    assert.ok((agent.freeSockets[Object.keys(agent.freeSockets)[0] ?? ""]?.length ?? 0) >= 1);
  });
});
