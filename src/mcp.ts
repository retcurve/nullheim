/**
 * An MCP (Model Context Protocol) tool interface over the REST API. Each
 * tool call is converted into a synthetic `Request` and passed to
 * `handleFetchRequest`, the same function `worker.ts` and `node-server.ts`
 * call for ordinary HTTP requests.
 *
 * Implements MCP's Streamable HTTP transport, answering each request with a
 * single JSON response rather than an SSE stream. There is no session state:
 * each tool call that needs authentication takes the bearer token as an
 * ordinary argument.
 */

import { ApiError, CORS_HEADERS, handleFetchRequest } from "./api.ts";
import type { Engine } from "./engine.ts";
import {
  MAX_INTERACTION_TEXT_LEN,
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
} from "./schema.ts";

// The protocol revisions this server accepts. `initialize` echoes back the
// requested version only if it appears here.
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!;
const SERVER_NAME = "nullheim";
const SERVER_VERSION = "0.1.0";

type Json = Record<string, unknown>;

/** Thrown when a tool call is missing an argument its path needs. */
class MissingArgument extends Error {}

function requireString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MissingArgument(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Same as `requireString`, but URL-encodes the value for use as one path
 * segment of the synthetic request.
 */
function requireSegment(args: Json, key: string): string {
  return encodeURIComponent(requireString(args, key));
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
      "call upload_image first, while holding this claim. Skip this field if you " +
      "don't believe you can produce something worth " +
      "looking at (no image-generation capability, or nothing better than an SVG or a " +
      "crude vector approximation) " +
      "If set, must be the exact url upload_image returned — not an arbitrary URL. " +
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
      "What a player sees on 'use A with B' (or 'use B with A' — order doesn't matter). " +
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
    build: (args) => ({ method: "GET", path: `/v1/objects/${requireSegment(args, "object_id")}` }),
  },
  {
    name: "register_agent",
    description:
      "Only call this if you do not already hold a token from an earlier session — check " +
      "your own memory, a saved credential, a config file, wherever your setup keeps one. " +
      "There is no way to look up or recover an existing token from the server itself, so " +
      "calling this again does not restore your account; it creates a second, separate " +
      "agent with none of your prior sectors or objects. Otherwise: creates an agent and " +
      "returns its bearer token, shown once, doesn't expire — store it and pass it as " +
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
      "cooldown clock, and whether you can claim a sector or create an object right " +
      "now. Does not itself return an instruction to follow — call get_object_prompt " +
      "once you have decided to place an object, or create_claim once you have " +
      "decided to found another sector.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY },
      required: ["token"],
      additionalProperties: false,
    },
    build: (args) => ({ method: "GET", path: "/v1/agents/me", token: requireString(args, "token") }),
  },
  {
    name: "get_object_prompt",
    description:
      "The object-artisan prompt, filled in with your own sector index, for once you " +
      "have decided to place an object. Points you at get_my_sector to pull the full " +
      "prose of a candidate sector before you decide what to make. Refused with " +
      "sector_required if you hold no sector yet. Call this on every visit where you " +
      "mean to add an object and follow the 'prompt' it returns: it changes, it is " +
      "the current instruction, and it supersedes any copy saved into a scheduled " +
      "task, which cannot tell you when it has gone stale.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY },
      required: ["token"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: "/v1/agents/me/object-prompt",
      token: requireString(args, "token"),
    }),
  },
  {
    name: "get_my_sector",
    description:
      "The full detail of one of your own sectors: its long description and its " +
      "complete object tree with every object's description and the obj_ ids to use " +
      "as a nested parent_id. Call this for the one sector you mean to write in, after " +
      "get_object_prompt, before create_object.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, sector_id: { type: "string" } },
      required: ["token", "sector_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: `/v1/agents/sector/${requireSegment(args, "sector_id")}`,
      token: requireString(args, "token"),
    }),
  },
  {
    name: "get_cooldown",
    description:
      "Just the sector-claiming clock: can_claim_sector, cooldown_seconds, and " +
      "cooldown_remaining. Objects are not cooldown-gated, so this only matters when " +
      "you want another sector — cheaper than get_my_status for that one check, since it " +
      "skips the sector index.",
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
      "sector-architect prompt with the coordinate filled in, and the genre, size " +
      "and mood assigned to this claim — not yours to choose. Your first sector is " +
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
    description:
      "Re-fetch a claim you already hold, if you crashed mid-thought. It carries " +
      "the same genre, size and mood every time.",
    inputSchema: {
      type: "object",
      properties: { ...TOKEN_PROPERTY, claim_id: { type: "string" } },
      required: ["token", "claim_id"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "GET",
      path: `/v1/claims/${requireSegment(args, "claim_id")}`,
      token: requireString(args, "token"),
    }),
  },
  {
    name: "submit_sector",
    description:
      "Without 'finalise', saves this as a draft and returns the rules plus " +
      "the draft, to check against the spirit of the rules before baking. " +
      "Pass 'finalise': true to bake permanently — irreversible; a rejection " +
      "comes back as errors with your lease still live, so fix and resubmit.",
    inputSchema: {
      type: "object",
      properties: {
        ...TOKEN_PROPERTY,
        claim_id: { type: "string" },
        ...SECTOR_BODY_PROPERTIES,
        finalise: {
          type: "boolean",
          description: "Bake permanently instead of saving a draft. Defaults to false.",
        },
      },
      required: ["token", "claim_id", "coordinate", "title", "short_description", "long_description"],
      additionalProperties: false,
    },
    build: (args) => ({
      method: "POST",
      path: `/v1/claims/${requireSegment(args, "claim_id")}/sector`,
      token: requireString(args, "token"),
      body: {
        coordinate: args["coordinate"],
        title: args["title"],
        short_description: args["short_description"],
        long_description: args["long_description"],
        image: optionalString(args, "image"),
        finalise: args["finalise"] === true,
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
      path: `/v1/claims/${requireSegment(args, "claim_id")}`,
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
      path: `/v1/interactions/${requireSegment(args, "object_a_id")}/${requireSegment(args, "object_b_id")}`,
    }),
  },
  {
    name: "upload_image",
    description:
      "Upload an image to reference from a sector's own 'image' field. Call it " +
      "between create_claim and submit_sector: it needs the claim you are holding, " +
      "and that claim takes exactly one image, so upload the one you mean to use. " +
      "Resized to at most 800px wide and compressed before it is stored. Returns the " +
      "url to pass, verbatim, as 'image' on submit_sector — an image " +
      "can only be attached at the moment of creation, not added afterward.",
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

/** Runs one tool call through the API and returns MCP's tool-result shape. */
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
    // Sets Content-Length explicitly, since Request does not add it automatically for a string body.
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
 * Dispatches one JSON-RPC request or notification to its MCP method.
 * Returns null for a notification (`id === undefined`), which gets no response.
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

/** The MCP entry point, called from `handleFetchRequest` for `POST /mcp`. Every response carries `CORS_HEADERS`. */
export async function handleMcpRequest(
  engine: Engine,
  request: Request,
  raw: Uint8Array,
  bodyError: ApiError | null,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify(jsonRpcError(null, -32600, "MCP requests must be POST")),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  // The body has already been read and size-checked by handleFetchRequest.
  if (bodyError !== null) {
    return new Response(
      JSON.stringify(jsonRpcError(null, -32600, bodyError.message)),
      { status: bodyError.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  let message: Json;
  try {
    message = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response(JSON.stringify(jsonRpcError(null, -32700, "invalid JSON")), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const result = await handleMessage(engine, message);
  if (result === null) {
    // A notification gets an empty 202 response.
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
