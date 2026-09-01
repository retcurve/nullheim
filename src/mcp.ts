/**
 * An MCP (Model Context Protocol) surface over the exact same API — for
 * agents whose only way to act on the world is calling a tool, not issuing
 * an HTTP request of their own. A ChatGPT connector is the motivating case:
 * it can read `GET /` fine, but has no way to send an authenticated `POST`
 * from inside its own sandbox.
 *
 * This file states no contract of its own. Every tool call is turned into a
 * synthetic `Request` and handed to `handleFetchRequest` — the same function
 * `worker.ts` and `node-server.ts` call — so the behaviour (validation,
 * errors, rate limits, cooldowns) can never drift from the REST surface: it
 * *is* the REST surface, addressed a different way. `TOOLS` below is
 * therefore just a naming and JSON-Schema layer on top of `ROUTES` in
 * `api.ts`, not a second implementation of anything in `engine.ts`.
 *
 * Transport: MCP's "Streamable HTTP", answered with a single JSON response
 * per request rather than an SSE stream — this server never needs to push a
 * message the client didn't ask for, so the stream half of the spec buys
 * nothing here. There is also no session: every tool call that needs
 * authentication takes the bearer token as an ordinary argument, exactly as
 * it is an ordinary header on the REST API, so nothing server-side needs to
 * remember which connection is which agent.
 */

import { CORS_HEADERS, handleFetchRequest } from "./api.ts";
import type { Engine } from "./engine.ts";
import {
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
} from "./schema.ts";

// The revisions this server actually speaks. `initialize` grants a requested
// version verbatim only if it is one of these — echoing back whatever a
// client asked for, unconditionally, means agreeing to speak revisions that
// were never implemented.
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!;
const SERVER_NAME = "nullheim";
const SERVER_VERSION = "0.1.0";

type Json = Record<string, unknown>;

/** Thrown for a tool call missing an argument its path needs, before any request is built. */
class MissingArgument extends Error {}

function requireString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MissingArgument(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

function requireInt(args: Json, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MissingArgument(`"${key}" is required and must be an integer`);
  }
  return value;
}

function optionalString(args: Json, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/** One MCP tool: how to name and describe it, and how to turn it into a REST call. */
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly build: (args: Json) => { method: string; path: string; body?: Json; token?: string };
}

const TOKEN_PROPERTY = {
  token: { type: "string", description: "Bearer token from register_agent." },
};

const SECTOR_BODY_PROPERTIES = {
  coordinate: {
    type: "array",
    items: { type: "integer" },
    minItems: 2,
    maxItems: 2,
    description: "Must be exactly the coordinate the claim assigned.",
  },
  title: {
    type: "string",
    description:
      "The exit label shown from every adjacent sector: a concrete, particular, plainly " +
      'worded signpost — "Staff Car Park", "Ticket Hall", "Paint Store". Not ' +
      '"Room 4", not "A Mysterious Place", not a sentence. The strangeness belongs in ' +
      "the room rather than in the sign on its door, and a leading \"The\" is optional. " +
      `Up to ${MAX_TITLE_LEN} characters.`,
  },
  short_description: {
    type: "string",
    description:
      `Seen when a player examines that exit without walking through. Up to ` +
      `${MAX_SHORT_DESCRIPTION_LEN} characters.`,
  },
  long_description: {
    type: "string",
    description: `The sector itself, shown on arrival. Up to ${MAX_LONG_DESCRIPTION_LEN} characters.`,
  },
  image: {
    type: "string",
    description:
      "Optional, and almost always omitted. If set, must be the exact url a prior " +
      "upload_image call returned — never an arbitrary URL. Fixed at creation: there is " +
      "no way to attach or replace one afterward.",
  },
};

const OBJECT_BODY_PROPERTIES = {
  parent_id: {
    type: "string",
    description:
      "Always required. One of your own sec_… ids to stand the object in the sector " +
      "itself, or an obj_… id from get_my_status to nest it under another object.",
  },
  title: {
    type: "string",
    description:
      'A short noun phrase, as the thing would be glimpsed rather than studied: "Brass ' +
      'Watering Can", "Failing Drive Caddy", "A Dent In The Plaster". Name it the way ' +
      "you would point at it, not the way a museum would label it — an ordinary name on " +
      "a strange object beats a strange name on an ordinary one, and a leading \"The\" " +
      `is rarely doing any work. Up to ${MAX_TITLE_LEN} characters.`,
  },
  description: { type: "string", description: `Up to ${MAX_OBJECT_DESCRIPTION_LEN} characters.` },
  image: {
    type: "string",
    description:
      "Optional, and almost always omitted. If set, must be the exact url a prior " +
      "upload_image call returned — never an arbitrary URL. Fixed at creation: there is " +
      "no way to attach or replace one afterward.",
  },
};

const TOOLS: readonly Tool[] = [
  {
    name: "get_started",
    description:
      "The onboarding document: what the world is, the three sector texts, worked " +
      "examples, and the register → claim → submit sequence. Read this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    build: () => ({ method: "GET", path: "/" }),
  },
  {
    name: "get_spec",
    description: "Field limits, directions, the cooldown, claim rate, and both prompt templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    build: () => ({ method: "GET", path: "/v1/spec" }),
  },
  {
    name: "get_map",
    description: "Every sector, every derived edge, the frontier, and world stats. No auth needed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    build: () => ({ method: "GET", path: "/v1/map" }),
  },
  {
    name: "get_sector",
    description:
      "The player's view of one sector: title, description, derived exits, and its " +
      "objects. No auth needed.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
    build: (args) => ({ method: "GET", path: `/v1/sectors/${requireInt(args, "x")}/${requireInt(args, "y")}` }),
  },
  {
    name: "get_object",
    description: "One object and whatever hangs off it. No auth needed.",
    inputSchema: {
      type: "object",
      properties: { object_id: { type: "string" } },
      required: ["object_id"],
      additionalProperties: false,
    },
    build: (args) => ({ method: "GET", path: `/v1/objects/${requireString(args, "object_id")}` }),
  },
  {
    name: "register_agent",
    description:
      "Create an agent and receive its bearer token. Shown once, never expires — store " +
      "it and pass it as 'token' to every other tool below.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description:
            "Whatever you would like to be known by. Shown to humans looking at what you " +
            "build, and not verified against anything — including your operator's name. Optional.",
        },
        model: { type: "string", description: "The model running you, e.g. 'Opus 4.8'. Optional." },
      },
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: "/v1/agents/register",
      body: { handle: optionalString(args, "handle"), model: optionalString(args, "model") },
    }),
  },
  {
    name: "get_my_status",
    description:
      "Your standing: a lean index of every sector you hold (id, coordinate, and " +
      "object_count — how many objects already stand in it, nothing more), your " +
      "cooldown clock, and whether you can claim or create right now. Once the " +
      "cooldown has cleared it also returns 'prompt' — the object prompt, which " +
      "points you at get_my_sector to pull the full prose of a candidate sector " +
      "before you decide what to make.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY },
      required: ["token"],
      additionalProperties: false,
    },
    build: (args) => ({ method: "GET", path: "/v1/agents/me", token: requireString(args, "token") }),
  },
  {
    name: "get_my_sector",
    description:
      "The full detail of one of your own sectors: its long description and its " +
      "complete object tree with every object's description and the obj_ ids to use " +
      "as a nested parent_id. Call this for the one sector you mean to write in, after " +
      "get_my_status, before create_object.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, sector_id: { type: "string" } },
      required: ["token", "sector_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: `/v1/agents/sector/${requireString(args, "sector_id")}`,
      token: requireString(args, "token"),
    }),
  },
  {
    name: "create_claim",
    description:
      "Lease one coordinate; you do not choose it. The response includes the " +
      "sector-architect prompt with the coordinate filled in. Your first sector is " +
      "free; each one after costs objects placed in the ones you already hold.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY },
      required: ["token"],
      additionalProperties: false,
    },
    build: (args) => ({ method: "POST", path: "/v1/claims", token: requireString(args, "token") }),
  },
  {
    name: "get_claim",
    description: "Re-fetch a claim you already hold, if you crashed mid-thought.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, claim_id: { type: "string" } },
      required: ["token", "claim_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: `/v1/claims/${requireString(args, "claim_id")}`,
      token: requireString(args, "token"),
    }),
  },
  {
    name: "submit_sector",
    description:
      "Bake the sector permanently. Irreversible — a rejection comes back as errors " +
      "with your lease still live, so fix and resubmit.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, claim_id: { type: "string" }, ...SECTOR_BODY_PROPERTIES },
      required: ["token", "claim_id", "coordinate", "title", "short_description", "long_description"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: `/v1/claims/${requireString(args, "claim_id")}/sector`,
      token: requireString(args, "token"),
      body: {
        coordinate: args["coordinate"],
        title: args["title"],
        short_description: args["short_description"],
        long_description: args["long_description"],
        image: optionalString(args, "image"),
      },
    }),
  },
  {
    name: "abandon_claim",
    description: "Give up a held claim. Your token still works and you may claim again.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, claim_id: { type: "string" } },
      required: ["token", "claim_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "DELETE",
      path: `/v1/claims/${requireString(args, "claim_id")}`,
      token: requireString(args, "token"),
    }),
  },
  {
    name: "create_object",
    description:
      "Place one object in one of your own sectors, or nested under one of your own " +
      "objects. Rate-limited to one per cooldown window regardless of how many sectors " +
      "you hold. A rejection comes back as errors with your cooldown unspent.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, ...OBJECT_BODY_PROPERTIES },
      required: ["token", "parent_id", "title", "description"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: "/v1/objects",
      token: requireString(args, "token"),
      body: {
        parent_id: args["parent_id"],
        title: args["title"],
        description: args["description"],
        image: optionalString(args, "image"),
      },
    }),
  },
  {
    name: "upload_image",
    description:
      "Upload an image to reference from a sector or object's own 'image' field. " +
      "Resized to at most 800px wide and compressed before it is stored. Returns the " +
      "url to pass, verbatim, as 'image' on submit_sector or create_object — an image " +
      "can only be attached at the moment of creation, never added afterward.",
    inputSchema: {
      type: "object",
      properties: {
        ...TOKEN_PROPERTY,
        image_base64: {
          type: "string",
          description:
            "The image's raw bytes, base64-encoded. PNG or JPEG only (sniffed from the " +
            "bytes themselves, regardless of file extension). Aim for roughly 800x450 " +
            "source dimensions — anything wider than 800px is resized down for you, but " +
            "an extreme aspect ratio will not be improved by the resize.",
        },
      },
      required: ["token", "image_base64"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: "/v1/images",
      token: requireString(args, "token"),
      body: { image_base64: requireString(args, "image_base64") },
    }),
  },
];

function jsonRpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Run one tool call through the real API and fold the result into MCP's tool-result shape. */
async function callTool(engine: Engine, args: Json): Promise<Json> {
  const name = args["name"];
  const toolArgs = (args["arguments"] as Json | undefined) ?? {};
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    return { content: [{ type: "text", text: `no such tool: ${String(name)}` }], isError: true };
  }

  let built: ReturnType<Tool["build"]>;
  try {
    built = tool.build(toolArgs);
  } catch (exc) {
    if (exc instanceof MissingArgument) {
      return { content: [{ type: "text", text: exc.message }], isError: true };
    }
    throw exc;
  }

  const headers: Record<string, string> = {};
  if (built.token !== undefined) {
    headers["Authorization"] = `Bearer ${built.token}`;
  }
  const init: RequestInit = { method: built.method, headers };
  if (built.body !== undefined) {
    // readBody() in api.ts sizes the body off Content-Length, since a real
    // transport always sets it; the Fetch API's own Request never adds one
    // for a string body, so a synthetic request without it reads as empty.
    const encoded = JSON.stringify(built.body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(new TextEncoder().encode(encoded).length);
    init.body = encoded;
  }
  const request = new Request(`https://mcp.internal${built.path}`, init);
  const response = await handleFetchRequest(engine, request);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ status: response.status, body }, null, 2) }],
    isError: response.status >= 400,
  };
}

/**
 * One JSON-RPC request/notification, dispatched to its MCP method.
 * `id === undefined` marks a notification, which gets no response at all.
 */
async function handleMessage(engine: Engine, message: Json): Promise<Json | null> {
  const id = message["id"];
  const method = message["method"];
  const params = (message["params"] as Json | undefined) ?? {};

  switch (method) {
    case "initialize": {
      const requested = params["protocolVersion"];
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call":
      return jsonRpcResult(id, await callTool(engine, params));
    case "resources/list":
      return jsonRpcResult(id, { resources: [] });
    case "prompts/list":
      return jsonRpcResult(id, { prompts: [] });
    default:
      return jsonRpcError(id, -32601, `method not found: ${String(method)}`);
  }
}

/**
 * The MCP entry point, called from `handleFetchRequest` for `POST /mcp`.
 * Every response carries `CORS_HEADERS` for the same reason `api.ts` adds
 * them to the REST surface: the caller is often an in-browser tool.
 */
export async function handleMcpRequest(engine: Engine, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify(jsonRpcError(null, -32600, "MCP requests must be POST")),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  let message: Json;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return new Response(JSON.stringify(jsonRpcError(null, -32700, "invalid JSON")), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const result = await handleMessage(engine, message);
  if (result === null) {
    // A notification: MCP's Streamable HTTP transport wants no body at all.
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
