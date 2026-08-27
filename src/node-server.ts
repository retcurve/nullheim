/**
 * The Node transport: a `node:http` server in front of `handleFetchRequest`.
 *
 * Everything agent-facing is handled by the shared, runtime-agnostic core in
 * `api.ts` — this file's only job is bridging `IncomingMessage`/
 * `ServerResponse` to `Request`/`Response`, and serving `public/` under
 * `/enter/*`, which is a Node-only (node:fs) concern with no Workers
 * equivalent in this module (Cloudflare serves it from the Assets binding
 * instead — see `worker.ts`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleFetchRequest, MAX_BODY_BYTES } from "./api.ts";
import type { Engine } from "./engine.ts";

// --- the human player frontend ----------------------------------------------
//
// `public/` is plain static HTML/CSS/JS — no build step, no framework, no new
// dependency — served under `/enter/*` and touching nothing that agents talk
// to. It reads the world exclusively through `GET /v1/sectors/{x}/{y}` and
// `GET /v1/objects/{id}`, the same public reads any other client can make.

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ENTER_PREFIX = "/enter";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/** Serves one file from `public/` under `/enter/*`. Returns false on any miss. */
async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  let rel = pathname.slice(ENTER_PREFIX.length);
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

// --- the IncomingMessage <-> Request/Response bridge -------------------------

/**
 * Read the body eagerly, up to `MAX_BODY_BYTES`, and refuse (closing the
 * connection) anything declared larger without reading it — the request is
 * on a keep-alive socket, and a body left unread would desync the next
 * request parsed off the same connection.
 */
function readNodeBody(
  req: IncomingMessage,
): Promise<{ raw: Uint8Array; tooLarge: boolean; badHeader: boolean }> {
  return new Promise((resolve, reject) => {
    const declared = req.headers["content-length"];
    const INTEGER = /^\s*[+-]?\d+\s*$/;
    if (declared !== undefined && !INTEGER.test(declared)) {
      resolve({ raw: new Uint8Array(0), tooLarge: false, badHeader: true });
      req.resume();
      return;
    }
    const length = declared === undefined ? 0 : Number(declared);
    if (length > MAX_BODY_BYTES) {
      resolve({ raw: new Uint8Array(0), tooLarge: true, badHeader: false });
      req.resume();
      return;
    }
    if (length === 0) {
      resolve({ raw: new Uint8Array(0), tooLarge: false, badHeader: false });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () =>
      resolve({ raw: Buffer.concat(chunks), tooLarge: false, badHeader: false }),
    );
    req.on("error", reject);
  });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * The body is read up front — a raw error (bad Content-Length, or a body too
 * large to accept) is answered directly here, closing the connection, before
 * a `Request` is even built. Everything else becomes one `Request` and is
 * handed to the shared, transport-agnostic core.
 */
async function handleNodeRequest(
  engine: Engine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const { raw, tooLarge, badHeader } = await readNodeBody(req);
  if (tooLarge || badHeader) {
    res.setHeader("Connection", "close");
    const payload = badHeader
      ? { error: { code: "bad_header", message: "Content-Length is not a number" } }
      : { error: { code: "payload_too_large", message: `body exceeds ${MAX_BODY_BYTES} bytes` } };
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(badHeader ? 400 : 413, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    });
    res.end(body);
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  if (method === "GET" && (url.pathname === ENTER_PREFIX || url.pathname.startsWith(`${ENTER_PREFIX}/`))) {
    if (await serveStatic(url.pathname, res)) {
      return;
    }
    const body = Buffer.from(
      JSON.stringify({ error: { code: "no_such_route", message: `${method} ${url.pathname}` } }),
    );
    res.writeHead(404, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
    return;
  }

  const canHaveBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit = { method, headers: toWebHeaders(req) };
  if (canHaveBody && raw.length > 0) {
    init.body = raw;
  }
  const request = new Request(url, init);
  const response = await handleFetchRequest(engine, request);
  await sendWebResponse(res, response);
}

export interface MakeServerOptions {
  host?: string;
  port?: number;
  quiet?: boolean;
}

export function makeServer(engine: Engine, options: MakeServerOptions = {}): Server {
  const quiet = options.quiet ?? false;
  const server = createServer((req, res) => {
    handleNodeRequest(engine, req, res).catch((exc) => {
      if (!quiet) {
        console.error(exc);
      }
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify({ error: { code: "internal", message: String(exc) } }));
        res.writeHead(500, { "Content-Type": "application/json", "Content-Length": body.length });
        res.end(body);
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
