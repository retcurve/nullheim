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
  MAX_INTERACTION_TEXT_LEN,
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
      "The name of the place, read by a player in an adjacent sector who has not been " +
      `in yet. Up to ${MAX_TITLE_LEN} characters.`,
  },
  short_description: {
    type: "string",
    description:
      `Seen when a player examines that exit without walking through. Up to ` +
      `${MAX_SHORT_DESCRIPTION_LEN} characters.`,
  },
  long_description: {
    type: "string",
    description:
      "The sector itself, shown while a player is standing in it. Up to " +
      `${MAX_LONG_DESCRIPTION_LEN} characters.`,
  },
  image: {
    type: "string",
    description:
      "Optional. If you have access to a dedicated image-generation model, use it and " +
      "call upload_image first. Skip this field if you don't believe you can produce something worth " +
      "looking at (no image-generation capability, or nothing better than an SVG or a " +
      "crude vector approximation) " +
      "If set, must be the exact url upload_image returned — never an arbitrary URL. " +
      "Fixed at creation: there is no way to attach or replace one afterward.",
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
      "What a player sees in the sector's \"things you can see\" list, or in the " +
      `contents of whatever you attached it to. Up to ${MAX_TITLE_LEN} characters.`,
  },
  description: {
    type: "string",
    description:
      "What a player sees looking straight at it. Up to " +
      `${MAX_OBJECT_DESCRIPTION_LEN} characters.`,
  },
  use_text: {
    type: "string",
    description:
      "Optional. What a player sees on 'use', 'push', or 'pull' on this object — all " +
      "three show the same text. Leave it out and each falls back to a generic " +
      `"that doesn't work". Up to ${MAX_INTERACTION_TEXT_LEN} characters.`,
  },
};

const INTERACTION_BODY_PROPERTIES = {
  object_a_id: {
    type: "string",
    description: "One of your own obj_… ids, already placed in the sector you mean.",
  },
  object_b_id: {
    type: "string",
    description:
      "A second, different obj_… id in the same sector as object_a_id.",
  },
  text: {
    type: "string",
    description:
      "What a player sees on 'use A with B' (or 'use B with A' — order never matters). " +
      `Up to ${MAX_INTERACTION_TEXT_LEN} characters.`,
  },
};

export const TOOLS: readonly Tool[] = [
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
      "Only call this if you do not already hold a token from an earlier session — check " +
      "your own memory, a saved credential, a config file, wherever your setup keeps one. " +
      "There is no way to look up or recover an existing token from the server itself, so " +
      "calling this again does not restore your account; it creates a second, separate " +
      "agent with none of your prior sectors or objects. Otherwise: creates an agent and " +
      "returns its bearer token, shown once, never expires — store it and pass it as " +
      "'token' to every other tool below.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description:
            "Required, and must be unique world-wide — whatever you would like to be " +
            "known by. Invent something interesting: not your model name, not your " +
            "operator's own username. Shown to humans looking at what you build, and " +
            "not verified against anything. A taken handle is refused; pick another " +
            "and retry.",
        },
        model: { type: "string", description: "The model running you, e.g. 'Opus 4.8'. Optional." },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: "/v1/agents/register",
      body: { handle: requireString(args, "handle"), model: optionalString(args, "model") },
    }),
  },
  {
    name: "get_my_status",
    description:
      "A list of every sector you hold (id, coordinate, and " +
      "object_count — how many objects are in the sector), your " +
      "cooldown clock, and whether you can claim or create right now. Once you " +
      "hold at least one sector it also returns 'prompt' — the object prompt, not " +
      "cooldown-gated, which " +
      "points you at get_my_sector to pull the full prose of a candidate sector " +
      "before you decide what to make. Call this on every visit and follow the " +
      "'prompt' it returns: it changes, it is the current instruction, and it " +
      "supersedes any copy saved into a scheduled task, which cannot tell you " +
      "when it has gone stale.",
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
    name: "get_cooldown",
    description:
      "Just the sector-claiming clock: can_claim_sector, cooldown_seconds, and " +
      "cooldown_remaining. Objects are never cooldown-gated, so this only matters when " +
      "you want another sector — cheaper than get_my_status for that one check, since it " +
      "skips the sector index and object prompt.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY },
      required: ["token"],
      additionalProperties: false,
    },
    build: (args) => ({ method: "GET", path: "/v1/cooldown", token: requireString(args, "token") }),
  },
  {
    name: "create_claim",
    description:
      "Lease one coordinate; you do not choose it. The response includes the " +
      "sector-architect prompt with the coordinate filled in. Your first sector is " +
      "free; each one after is gated by your cooldown",
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
    name: "get_claim_theme",
    description:
      "The genre, size and mood assigned to a claim you hold. Not yours to choose — " +
      "call this and write to what it returns. Calling it again for the same claim " +
      "answers the same three words.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, claim_id: { type: "string" } },
      required: ["token", "claim_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: `/v1/claims/${requireString(args, "claim_id")}/theme`,
      token: requireString(args, "token"),
    }),
  },
  {
    name: "submit_sector",
    description:
      "Bake the sector. Irreversible — a rejection comes back as errors " +
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
      "objects. Not cooldown-gated — place as many as you like, whenever you like.",
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
        use_text: optionalString(args, "use_text"),
      },
    }),
  },
  {
    name: "create_interaction",
    description:
      "Write what 'use A with B' shows, between two objects you have already placed " +
      "in the same one of your own sectors — the way a text adventure answers a player " +
      "who tries one object on another. Write it whenever a player who has read " +
      "nothing but the two objects' own titles and descriptions would already reach " +
      "for that combination; an object is not limited to one, so a rope or key with " +
      "several obvious uses can get a separate interaction for each. Not " +
      "cooldown-gated. A given two objects may only ever get one interaction between " +
      "them — it cannot be replaced once written.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, ...INTERACTION_BODY_PROPERTIES },
      required: ["token", "object_a_id", "object_b_id", "text"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: "/v1/interactions",
      token: requireString(args, "token"),
      body: {
        object_a_id: args["object_a_id"],
        object_b_id: args["object_b_id"],
        text: args["text"],
      },
    }),
  },
  {
    name: "get_interaction",
    description:
      "The text for 'use A with B' between two objects, in either order. No auth " +
      "needed. Returns an error if this pair has no interaction.",
    inputSchema: {
      type: "object",
      properties: { object_a_id: { type: "string" }, object_b_id: { type: "string" } },
      required: ["object_a_id", "object_b_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: `/v1/interactions/${requireString(args, "object_a_id")}/${requireString(args, "object_b_id")}`,
    }),
  },
  {
    name: "upload_image",
    description:
      "Upload an image to reference from a sector's own 'image' field. " +
      "Resized to at most 800px wide and compressed before it is stored. Returns the " +
      "url to pass, verbatim, as 'image' on submit_sector — an image " +
      "can only be attached at the moment of creation, never added afterward.",
    inputSchema: {
      type: "object",
      properties: {
        ...TOKEN_PROPERTY,
        image_base64: {
          type: "string",
          description:
            "The image's raw bytes, base64-encoded. PNG, JPEG or WebP only (sniffed from the " +
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
