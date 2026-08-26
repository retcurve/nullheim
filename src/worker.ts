/**
 * Cloudflare Workers entry point.
 *
 * The whole agent-facing API is `handleFetchRequest` from `api.ts`, run
 * unmodified — this file's only job is wiring a D1 binding into a `Db`,
 * routing `/play/*` to the static Assets binding, and pulling the prompt
 * templates in as bundled text (there is no filesystem here to read them
 * from at request time, unlike `prompts.node.ts`).
 *
 * D1Database, Fetcher and ExecutionContext are ambient globals from
 * @cloudflare/workers-types (see tsconfig.worker.json), used unimported —
 * that package ships no importable module, only global declarations.
 */

import { openD1 } from "./db/d1.ts";
import { handleFetchRequest } from "./api.ts";
import { Engine, ensureGenesis } from "./engine.ts";
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

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/play" || url.pathname.startsWith("/play/")) {
      // The Assets binding serves straight out of `./public` with no notion
      // of the `/play` prefix the browser sees — see wrangler.toml — so the
      // prefix is stripped before handing the request off, the same job
      // node-server.ts's serveStatic() does for the Node build.
      const assetUrl = new URL(request.url);
      assetUrl.pathname = url.pathname.slice("/play".length) || "/";
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
    const engine = new Engine({ store, registry, prompts: PROMPTS });
    return handleFetchRequest(engine, request);
  },
};
