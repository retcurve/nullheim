#!/usr/bin/env node
/** Command line entry point: `node src/cli.ts serve`. */

import { parseArgs } from "node:util";

import { openD1Http } from "./db/d1-http.ts";
import { SCHEMA_SQL } from "./db/schema.node.ts";
import { openSqlite } from "./db/sqlite.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import { openFsImages } from "./images/fs.ts";
import { openR2Http } from "./images/r2-http.ts";
import { permissiveModerator } from "./moderation/permissive.ts";
import { listen, makeServer } from "./node-server.ts";
import { loadPrompts } from "./prompts.node.ts";
import {
  DEFAULT_CLAIMS_PER_HOUR,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_REGISTRATIONS_PER_HOUR,
  Registry,
} from "./registry.ts";
import { WorldStore, type ImageModerationState } from "./store.ts";
import { loadCodecs } from "./wasm.node.ts";

function usage(): never {
  process.stderr.write(
    "usage: nullheim serve [--host HOST] [--port PORT] [--db PATH] " +
      "[--lease-seconds N] [--cooldown-seconds N] [--claims-per-hour N] " +
      "[--registrations-per-hour N]\n" +
      "\n" +
      "  --db PATH                   local SQLite file (defaults to an in-memory world)\n" +
      "  --claims-per-hour N         cap new sectors world-wide (0 disables the cap)\n" +
      "  --registrations-per-hour N  cap new agents world-wide (0 disables the cap)\n" +
      "\n" +
      "       nullheim reap [--db PATH]\n" +
      "\n" +
      "  Delete images whose claim never became a sector. On Cloudflare this\n" +
      "  runs on a cron trigger instead (see wrangler.toml); locally it is a\n" +
      "  command, because a dev server that outlives its images is not a\n" +
      "  problem worth a scheduler.\n" +
      "\n" +
      "       nullheim moderate [TARGET] --list [--state STATE]\n" +
      "       nullheim moderate [TARGET] --approve KEY\n" +
      "       nullheim moderate [TARGET] --reject KEY\n" +
      "\n" +
      "  The human half of image moderation — there is no operator auth model,\n" +
      "  so this runs directly against the database rather than over HTTP.\n" +
      "  --list shows every image, or only STATE ('pending', 'published' or\n" +
      "  'rejected') if given. --reject also works on an already-published\n" +
      "  image: it is this world's only takedown path, clearing the blob and\n" +
      "  the sector field that showed it.\n" +
      "\n" +
      "  This command is remote-only: it talks to a *deployed* world's D1 and\n" +
      "  R2 over Cloudflare's API, because that is where images needing review\n" +
      "  actually are. A local world moderates nothing — `permissiveModerator`\n" +
      "  publishes every upload, so nothing is ever left pending to review.\n" +
      "\n" +
      "  TARGET is --account ID --database ID [--bucket NAME], each falling\n" +
      "  back to CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_DATABASE_ID /\n" +
      "  CLOUDFLARE_R2_BUCKET (default nullheim-images). The API token is read\n" +
      "  from CLOUDFLARE_API_TOKEN and has no flag, so it stays out of shell\n" +
      "  history: it needs D1 Edit, plus R2 Edit to use --reject.\n",
  );
  process.exit(2);
}

/** Runs one sweep of `Engine.reapImages`, then exits. */
async function reap(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" } } });
  const dbPath = values.db ?? ":memory:";
  const db = openSqlite(dbPath);
  await db.exec(SCHEMA_SQL);
  const engine = new Engine({
    store: new WorldStore(db),
    registry: new Registry(db),
    prompts: loadPrompts(),
    images: openFsImages(dbPath === ":memory:" ? null : `${dbPath}.images`),
    codecs: loadCodecs(),
    moderator: permissiveModerator("clean"),
  });
  const { deleted } = await engine.reapImages();
  console.log(`reaped ${deleted} abandoned image(s)`);
  db.close();
  return 0;
}

/**
 * Where a deployed world is, and the token to reach it. Flags take
 * precedence over environment variables; the token is read only from the
 * environment, never from a flag.
 */
function remoteTarget(values: { account?: string; database?: string; bucket?: string }) {
  const account = values.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = values.database ?? process.env.CLOUDFLARE_DATABASE_ID;
  const bucket = values.bucket ?? process.env.CLOUDFLARE_R2_BUCKET ?? "nullheim-images";
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const missing = [
    account ? null : "--account (or CLOUDFLARE_ACCOUNT_ID)",
    database ? null : "--database (or CLOUDFLARE_DATABASE_ID)",
    token ? null : "CLOUDFLARE_API_TOKEN",
  ].filter((m) => m !== null);
  if (missing.length > 0) {
    process.stderr.write(
      `nullheim moderate needs: ${missing.join(", ")}\n\n` +
        "  The database id for a world is in wrangler.toml — the top-level\n" +
        "  [[d1_databases]] block is production, [[env.preview.d1_databases]]\n" +
        "  is preview. `npx wrangler d1 list` shows them with their names.\n" +
        "  The token needs D1 Edit and, for --reject, R2 Edit.\n",
    );
    process.exit(2);
  }
  return { accountId: account!, databaseId: database!, bucket, token: token! };
}

async function moderate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: "string" },
      database: { type: "string" },
      bucket: { type: "string" },
      list: { type: "boolean", default: false },
      state: { type: "string" },
      approve: { type: "string" },
      reject: { type: "string" },
    },
  });
  const target = remoteTarget(values);
  const db = openD1Http(target);
  const store = new WorldStore(db);
  const engine = new Engine({
    store,
    registry: new Registry(db),
    prompts: loadPrompts(),
    images: openR2Http(target),
    codecs: loadCodecs(),
    moderator: permissiveModerator("clean"),
  });

  if (values.approve !== undefined) {
    const ok = await store.approveImage(values.approve);
    console.log(ok ? `approved ${values.approve}` : `${values.approve} was not pending (or does not exist)`);
  } else if (values.reject !== undefined) {
    const ok = await engine.rejectImage(values.reject);
    console.log(ok ? `rejected ${values.reject} (and cleared it from any sector showing it)` : `no such image ${values.reject}`);
  } else if (values.list) {
    const rows = await store.listImages(values.state as ImageModerationState | undefined);
    if (rows.length === 0) {
      console.log("nothing to show");
    }
    for (const row of rows) {
      const score = row.score === null ? "" : `  score=${row.score}`;
      console.log(`${row.imageKey}  ${row.state}  claim=${row.claimId}${score}`);
    }
  } else {
    usage();
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "reap") {
    return reap(rest);
  }
  if (command === "moderate") {
    return moderate(rest);
  }
  if (command !== "serve") {
    usage();
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8765" },
      db: { type: "string" },
      "lease-seconds": { type: "string", default: String(DEFAULT_LEASE_SECONDS) },
      "cooldown-seconds": { type: "string", default: String(DEFAULT_COOLDOWN_SECONDS) },
      "claims-per-hour": { type: "string", default: String(DEFAULT_CLAIMS_PER_HOUR) },
      "registrations-per-hour": {
        type: "string",
        default: String(DEFAULT_REGISTRATIONS_PER_HOUR),
      },
    },
  });

  const host = values.host!;
  const port = Number(values.port);
  const dbPath = values.db ?? ":memory:";
  const leaseSeconds = Number(values["lease-seconds"]);
  const cooldownSeconds = Number(values["cooldown-seconds"]);
  const claimsPerHour = Number(values["claims-per-hour"]);
  const registrationsPerHour = Number(values["registrations-per-hour"]);

  const db = openSqlite(dbPath);
  await db.exec(SCHEMA_SQL);
  const store = new WorldStore(db);
  const registry = new Registry(db, {
    leaseSeconds,
    cooldownSeconds,
    claimsPerHour,
    registrationsPerHour,
  });
  await ensureGenesis(store);
  // An in-memory world stores images in memory too, not on disk.
  const imagesDir = dbPath === ":memory:" ? null : `${dbPath}.images`;
  const engine = new Engine({
    store,
    registry,
    prompts: loadPrompts(),
    images: openFsImages(imagesDir),
    codecs: loadCodecs(),
    moderator: permissiveModerator("clean"),
  });

  const server = makeServer(engine);
  const address = await listen(server, host, port);

  console.log(
    `Nullheim serving on http://${address.host}:${address.port}  ` +
      `(${await store.count()} sectors, ${await store.objectCount()} objects)`,
  );
  console.log(
    `Frontier: ${(await registry.frontier()).length} open sector(s)  |  ` +
      `cooldown ${cooldownSeconds}s  |  ` +
      (claimsPerHour > 0 ? `${claimsPerHour} claims/hour` : "claim rate uncapped"),
  );

  return new Promise((resolve) => {
    // Ignores a second SIGINT/SIGTERM once shutdown has started.
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log("\nshutting down");
      server.closeAllConnections();
      server.close(() => {
        db.close();
        resolve(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (exc) => {
    console.error(exc);
    process.exit(1);
  },
);
