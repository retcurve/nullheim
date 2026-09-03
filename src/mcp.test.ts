/** The MCP surface at POST /mcp, exercised as an MCP client would use it. */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import type { SqliteDb } from "./db/sqlite.ts";
import type { Engine } from "./engine.ts";
import { listen, makeServer } from "./node-server.ts";
import { makeEngine, sector } from "./testing.ts";

interface Ctx {
  base: string;
  server: Server;
}

let nextId = 1;

async function rpc(
  ctx: Ctx,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; payload: any }> {
  const response = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const status = response.status;
  const payload = status === 202 ? null : await response.json();
  return { status, payload };
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { status, payload } = await rpc(ctx, "tools/call", { name, arguments: args });
  assert.equal(status, 200);
  assert.equal(payload.jsonrpc, "2.0");
  return payload.result;
}

/** Every tool result carries `{status, body}` as its one text content block, JSON-encoded. */
function unwrap(result: any): { status: number; body: any } {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

async function registerAgent(ctx: Ctx, handle = "tester"): Promise<string> {
  const result = await callTool(ctx, "register_agent", { handle });
  assert.equal(result.isError, false);
  const { status, body } = unwrap(result);
  assert.equal(status, 201);
  return body.token;
}

type CtxOptions = { cooldownSeconds?: number; leaseSeconds?: number; claimsPerHour?: number };

async function makeCtx(options: CtxOptions = {}): Promise<{ ctx: Ctx; engine: Engine; db: SqliteDb }> {
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

describe("MCP protocol handshake", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("initialize grants a supported protocol version verbatim", async () => {
    const { status, payload } = await rpc(ctx, "initialize", { protocolVersion: "2025-03-26" });
    assert.equal(status, 200);
    assert.equal(payload.result.protocolVersion, "2025-03-26");
    assert.deepEqual(payload.result.capabilities, { tools: {} });
  });

  test("initialize never agrees to a protocol version it doesn't speak", async () => {
    const { payload } = await rpc(ctx, "initialize", { protocolVersion: "1999-01-01" });
    assert.equal(payload.result.protocolVersion, "2025-06-18");
  });

  test("responses allow the MCP client's own headers through CORS", async () => {
    const response = await fetch(`${ctx.base}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://chatgpt.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version",
      },
    });
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const header of ["authorization", "content-type", "mcp-protocol-version"]) {
      assert.ok(allowed.includes(header), header);
    }
  });

  test("a notification (no id) gets no body back", async () => {
    const response = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  });

  test("tools/list names every write and read the REST API exposes", async () => {
    const { payload } = await rpc(ctx, "tools/list");
    const names = payload.result.tools.map((t: any) => t.name);
    for (const expected of [
      "register_agent",
      "create_claim",
      "submit_sector",
      "create_object",
      "create_interaction",
      "get_interaction",
      "get_sector",
      "get_map",
    ]) {
      assert.ok(names.includes(expected), expected);
    }
  });

  test("an unknown method is a JSON-RPC error, not a crash", async () => {
    const { payload } = await rpc(ctx, "not/a/real/method");
    assert.equal(payload.error.code, -32601);
  });

  test("responses carry CORS headers, same as the REST surface", async () => {
    const response = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});

describe("MCP tools reach the exact same engine as the REST API", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup({ cooldownSeconds: 0 });
  });
  afterEach(teardown);

  test("register, claim and bake a sector end to end", async () => {
    const token = await registerAgent(ctx);

    const claimResult = await callTool(ctx, "create_claim", { token });
    const { status: claimStatus, body: claim } = unwrap(claimResult);
    assert.equal(claimStatus, 201);
    const claimId = claim.claim.claim_id;
    const [x, y] = claim.coordinate;

    const draft = sector([x, y]);
    const badSubmit = unwrap(
      await callTool(ctx, "submit_sector", {
        token,
        claim_id: claimId,
        coordinate: [x, y],
        title: "",
        short_description: draft.short_description,
        long_description: draft.long_description,
      }),
    );
    assert.equal(badSubmit.body.ok, false);

    const goodSubmit = unwrap(
      await callTool(ctx, "submit_sector", {
        token,
        claim_id: claimId,
        coordinate: [x, y],
        title: draft.title,
        short_description: draft.short_description,
        long_description: draft.long_description,
      }),
    );
    assert.equal(goodSubmit.status, 201);
    assert.equal(goodSubmit.body.ok, true);

    const view = unwrap(await callTool(ctx, "get_sector", { x, y }));
    assert.equal(view.status, 200);
    assert.equal(view.body.title, draft.title);
  });

  test("create_object, create_interaction and get_interaction end to end", async () => {
    const token = await registerAgent(ctx);
    const claim = unwrap(await callTool(ctx, "create_claim", { token })).body;
    const claimId = claim.claim.claim_id;
    const [x, y] = claim.coordinate;
    const draft = sector([x, y]);
    await callTool(ctx, "submit_sector", {
      token,
      claim_id: claimId,
      coordinate: [x, y],
      title: draft.title,
      short_description: draft.short_description,
      long_description: draft.long_description,
    });
    const me = unwrap(await callTool(ctx, "get_my_status", { token })).body;
    const sectorId = me.sectors[0].sector_id;

    const a = unwrap(
      await callTool(ctx, "create_object", { token, parent_id: sectorId, title: "Rope", description: "d" }),
    ).body.object.object_id;
    const b = unwrap(
      await callTool(ctx, "create_object", { token, parent_id: sectorId, title: "Hook", description: "d" }),
    ).body.object.object_id;

    const made = unwrap(
      await callTool(ctx, "create_interaction", {
        token,
        object_a_id: a,
        object_b_id: b,
        text: "Tied fast.",
      }),
    );
    assert.equal(made.status, 201);

    const fetched = unwrap(
      await callTool(ctx, "get_interaction", { object_a_id: b, object_b_id: a }),
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.text, "Tied fast.");
  });

  test("a REST-level auth failure comes back as an MCP tool error, not a crash", async () => {
    const result = await callTool(ctx, "get_my_status", { token: "not-a-real-token" });
    assert.equal(result.isError, true);
    const { status } = unwrap(result);
    assert.equal(status, 401);
  });

  test("a missing required argument is refused before any request is made", async () => {
    const result = await callTool(ctx, "get_sector", { x: 0 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /"y"/);
  });

  test("an unknown tool name is refused, not silently ignored", async () => {
    const result = await callTool(ctx, "not_a_real_tool");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no such tool/);
  });
});
