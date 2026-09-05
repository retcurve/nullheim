/**
 * Cloudflare Workers entry point.
 *
 * Wires a D1 binding into a `Db`, routes `/enter/*` to the static Assets
 * binding, and passes bundled prompt template text to `handleFetchRequest`
 * from `api.ts`.
 *
 * D1Database, Fetcher and ExecutionContext are used here as ambient globals
 * from @cloudflare/workers-types, without an import statement.
 */

import { openD1 } from "./db/d1.ts";
import { openR2 } from "./images/r2.ts";
import { ENTER_CSP, handleFetchRequest } from "./api.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import type { CodecModules } from "./image-processing.ts";
import { workersAiModerator } from "./moderation/workers-ai.ts";
import {
  DEFAULT_CLAIMS_PER_HOUR,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_REGISTRATIONS_PER_HOUR,
  Registry,
} from "./registry.ts";
import { WorldStore } from "./store.ts";

import sectorArchitect from "../prompts/sector_architect.md";
import objectArtisan from "../prompts/object_artisan.md";

const PROMPTS = { sector_architect: sectorArchitect, object_artisan: objectArtisan };

// Cloudflare's bundler resolves each bare `.wasm` import into a compiled
// `WebAssembly.Module` at build time.
import pngWasm from "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import jpegWasm from "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import jpegEncodeWasm from "../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
import resizeWasm from "../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
import webpDecodeWasm from "../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncodeWasm from "../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm";

const CODECS: CodecModules = {
  png: pngWasm,
  jpeg: jpegWasm,
  jpegEncode: jpegEncodeWasm,
  resize: resizeWasm,
  webpDecode: webpDecodeWasm,
  webpEncode: webpEncodeWasm,
};

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  AI: Ai;
  LEASE_SECONDS?: string;
  COOLDOWN_SECONDS?: string;
  CLAIMS_PER_HOUR?: string;
  REGISTRATIONS_PER_HOUR?: string;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Whether the genesis sector has already been checked for on this isolate. */
let genesisChecked = false;

/** True for any `*.workers.dev` hostname. */
function isWorkersDevHost(hostname: string): boolean {
  return hostname.endsWith(".workers.dev");
}

export default {
  /** The cron trigger. Deletes images whose claim never turned into a sector. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const { deleted } = await (await buildEngine(env)).reapImages();
        if (deleted > 0) {
          console.log(`reaped ${deleted} abandoned image(s)`);
        }
      })(),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blockIndexing = isWorkersDevHost(url.hostname);

    if (blockIndexing && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    const response = await routeRequest(request, url, env);
    // On a workers.dev host, adds an X-Robots-Tag header to every response.
    // Rebuilds the response rather than mutating it, since the Assets
    // binding's Response has immutable headers.
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
    // Strips the `/enter` prefix and serves the remaining path from the
    // static Assets binding, which serves out of `./public`.
    const assetUrl = new URL(request.url);
    assetUrl.pathname = url.pathname.slice("/enter".length) || "/";
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
    // Adds security headers to a rebuilt copy of the response, since the
    // Assets binding's Response has immutable headers.
    const headers = new Headers(asset.headers);
    headers.set("Content-Security-Policy", ENTER_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  }

  return handleFetchRequest(await buildEngine(env), request);
}

/** Builds one `Engine` over this request's bindings, used by both `fetch` and `scheduled`. */
async function buildEngine(env: Env): Promise<Engine> {
  const db = openD1(env.DB);
  const store = new WorldStore(db);
  const registry = new Registry(db, {
    leaseSeconds: numberEnv(env.LEASE_SECONDS, DEFAULT_LEASE_SECONDS),
    cooldownSeconds: numberEnv(env.COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS),
    claimsPerHour: numberEnv(env.CLAIMS_PER_HOUR, DEFAULT_CLAIMS_PER_HOUR),
    registrationsPerHour: numberEnv(env.REGISTRATIONS_PER_HOUR, DEFAULT_REGISTRATIONS_PER_HOUR),
  });
  if (!genesisChecked) {
    await ensureGenesis(store);
    genesisChecked = true;
  }
  return new Engine({
    store,
    registry,
    prompts: PROMPTS,
    images: openR2(env.IMAGES),
    codecs: CODECS,
    // Wraps env.AI.run in a plain closure rather than passing env.AI directly.
    moderator: workersAiModerator({ run: (model, inputs) => env.AI.run(model, inputs) }),
  });
}
