/**
 * Cloudflare Workers entry point.
 *
 * The whole agent-facing API is `handleFetchRequest` from `api.ts`, run
 * unmodified — this file's only job is wiring a D1 binding into a `Db`,
 * routing `/enter/*` to the static Assets binding, and pulling the prompt
 * templates in as bundled text (there is no filesystem here to read them
 * from at request time, unlike `prompts.node.ts`).
 *
 * D1Database, Fetcher and ExecutionContext are ambient globals from
 * @cloudflare/workers-types (see tsconfig.worker.json), used unimported —
 * that package ships no importable module, only global declarations.
 */

import { openD1 } from "./db/d1.ts";
import { openR2 } from "./images/r2.ts";
import { handleFetchRequest } from "./api.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import type { CodecModules } from "./image-processing.ts";
import {
  DEFAULT_CLAIMS_PER_HOUR,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_LEASE_SECONDS,
  Registry,
} from "./registry.ts";
import { WorldStore } from "./store.ts";

import sectorArchitect from "../prompts/sector_architect.md";
import objectArtisan from "../prompts/object_artisan.md";

const PROMPTS = { sector_architect: sectorArchitect, object_artisan: objectArtisan };

// Cloudflare's bundler resolves a bare `.wasm` import to a compiled
// `WebAssembly.Module` at build time — there is no filesystem, and no
// request-time fetch of the worker's own source, to load these from
// otherwise. `wasm.node.ts` gets the same five modules the other way, by
// compiling the bytes off disk at startup — see `image-processing.ts`'s
// module comment for why both runtimes need a pre-compiled Module rather
// than letting each codec package fetch its own.
import pngWasm from "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import jpegWasm from "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import resizeWasm from "../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
import webpDecodeWasm from "../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncodeWasm from "../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm";

const CODECS: CodecModules = {
  png: pngWasm,
  jpeg: jpegWasm,
  resize: resizeWasm,
  webpDecode: webpDecodeWasm,
  webpEncode: webpEncodeWasm,
};

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  LEASE_SECONDS?: string;
  COOLDOWN_SECONDS?: string;
  CLAIMS_PER_HOUR?: string;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The world only ever needs a genesis sector once, for the lifetime of the
 * database — not once per request. Migrations don't seed it (see
 * `db/schema.sql`), so this checks lazily on cold start and is cached for as
 * long as the isolate stays warm; two isolates racing this on the same cold
 * start just collide on genesis's primary key, and `ensureGenesis` treats
 * that as success.
 */
let genesisChecked = false;

/**
 * Every *.workers.dev hostname — the default one and every branch preview —
 * must never show up in Google/Bing: it's not the canonical address, and a
 * preview build indexed under its own URL would outlive the branch. Only
 * the custom domain (nullheim.sector808.org, once re-enabled) should be
 * indexable. There's no way to tell workers.dev and the custom domain apart
 * in wrangler.toml — both hit the same Worker — so this has to be a runtime
 * check on the request's own hostname.
 */
function isWorkersDevHost(hostname: string): boolean {
  return hostname.endsWith(".workers.dev");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blockIndexing = isWorkersDevHost(url.hostname);

    if (blockIndexing && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    const response = await routeRequest(request, url, env);
    // robots.txt alone doesn't stop a crawler that finds a link some other
    // way, so every response on a workers.dev host also carries the header
    // form of the same instruction. The Assets binding can hand back a
    // Response with immutable headers, so this rebuilds rather than mutates.
    if (blockIndexing) {
      const headers = new Headers(response.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};

async function routeRequest(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/enter" || url.pathname.startsWith("/enter/")) {
    // The Assets binding serves straight out of `./public` with no notion
    // of the `/enter` prefix the browser sees — see wrangler.toml — so the
    // prefix is stripped before handing the request off, the same job
    // node-server.ts's serveStatic() does for the Node build.
    const assetUrl = new URL(request.url);
    assetUrl.pathname = url.pathname.slice("/enter".length) || "/";
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }

  const db = openD1(env.DB);
  const store = new WorldStore(db);
  const registry = new Registry(db, {
    leaseSeconds: numberEnv(env.LEASE_SECONDS, DEFAULT_LEASE_SECONDS),
    cooldownSeconds: numberEnv(env.COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS),
    claimsPerHour: numberEnv(env.CLAIMS_PER_HOUR, DEFAULT_CLAIMS_PER_HOUR),
  });
  if (!genesisChecked) {
    await ensureGenesis(store);
    genesisChecked = true;
  }
  const engine = new Engine({
    store,
    registry,
    prompts: PROMPTS,
    images: openR2(env.IMAGES),
    codecs: CODECS,
  });
  return handleFetchRequest(engine, request);
}
