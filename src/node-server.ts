/**
 * The Node transport: a `node:http` server in front of `handleFetchRequest`.
 *
 * Agent-facing requests are handled by the shared core in `api.ts`. This file
 * bridges `IncomingMessage`/`ServerResponse` to `Request`/`Response`, and
 * serves `public/` under `/enter/*` from disk.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENTER_CSP, handleFetchRequest, maxBodyBytesFor } from "./api.ts";
import type { Engine } from "./engine.ts";

// --- the human player frontend ----------------------------------------------
//
// `public/` is plain static HTML/CSS/JS, served under `/enter/*`. It reads
// the world through `GET /v1/sectors/{x}/{y}` and `GET /v1/objects/{id}`.

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ENTER_PREFIX = "/enter";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/**
 * Serves one file from `public/` under `/enter/*`. Returns false on any miss.
 * A `HEAD` request skips the body but still computes and sends the ETag.
 */
async function serveStatic(pathname: string, res: ServerResponse, method: string): Promise<boolean> {
  let rel = pathname.slice(ENTER_PREFIX.length);
  if (rel === "" || rel === "/") {
    rel = "/index.html";
  }
  // Collapse any ".." segments before joining onto PUBLIC_DIR.
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
      // Security headers, matching the set api.ts puts on every response.
      "Content-Security-Policy": ENTER_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      // A hash of the file's contents, used by the frontend to detect changes.
      ETag: `"${createHash("sha1").update(data).digest("hex")}"`,
    });
    res.end(method === "HEAD" ? undefined : data);
    return true;
  } catch {
    return false;
  }
}

// --- the IncomingMessage <-> Request/Response bridge -------------------------

/**
 * Reads the request body, up to `maxBytes`. A body declared larger is
 * refused without being read, and the connection is closed.
 */
function readNodeBody(
  req: IncomingMessage,
  maxBytes: number,
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
    if (length > maxBytes) {
      resolve({ raw: new Uint8Array(0), tooLarge: true, badHeader: false });
      req.resume();
      return;
    }
    if (length === 0) {
      let received = 0;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.removeAllListeners();
          req.resume();
        }
      });
      resolve({ raw: new Uint8Array(0), tooLarge: false, badHeader: false });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.removeAllListeners();
        req.resume();
        resolve({ raw: new Uint8Array(0), tooLarge: true, badHeader: false });
        return;
      }
      chunks.push(chunk);
    });
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
 * Reads the body first. A bad Content-Length or an over-large body is
 * answered directly, closing the connection, before a `Request` is built.
 * Everything else is turned into a `Request` and handed to the shared core.
 */
async function handleNodeRequest(
  engine: Engine,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const maxBytes = maxBodyBytesFor(method, url.pathname);
  const { raw, tooLarge, badHeader } = await readNodeBody(req, maxBytes);
  if (tooLarge || badHeader) {
    res.setHeader("Connection", "close");
    const payload = badHeader
      ? { error: { code: "bad_header", message: "Content-Length is not a number" } }
      : { error: { code: "payload_too_large", message: `body exceeds ${maxBytes} bytes` } };
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(badHeader ? 400 : 413, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    });
    res.end(body);
    return;
  }

  if (
    (method === "GET" || method === "HEAD") &&
    (url.pathname === ENTER_PREFIX || url.pathname.startsWith(`${ENTER_PREFIX}/`))
  ) {
    if (await serveStatic(url.pathname, res, method)) {
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
        const body = Buffer.from(JSON.stringify({ error: { code: "internal", message: "internal server error" } }));
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
