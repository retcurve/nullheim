#!/usr/bin/env node
/** Command line entry point: `node src/cli.ts serve`. */

import { parseArgs } from "node:util";

import { openD1Wrangler } from "./db/d1-wrangler.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import { openFsImages } from "./images/fs.ts";
import { openR2Wrangler } from "./images/r2-wrangler.ts";
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
import { WorldStore } from "./store.ts";
import { loadCodecs } from "./wasm.node.ts";
import { runWrangler } from "./wrangler-cli.ts";

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
      "       nullheim moderate [--env preview] --list\n" +
      "       nullheim moderate [--env preview] --approve KEY\n" +
      "       nullheim moderate [--env preview] --reject KEY\n" +
      "\n" +
      "  The human half of image moderation — there is no operator auth model,\n" +
      "  so this runs directly against the database rather than over HTTP.\n" +
      "  --list shows every image awaiting review (state 'pending'), each with\n" +
      "  a Cloudflare dashboard link to view it. --reject also works on an\n" +
      "  already-published image: it is this world's only takedown path,\n" +
      "  clearing the blob and the sector field that showed it.\n" +
      "\n" +
      "  This command is remote-only: it shells out to `wrangler d1 execute`\n" +
      "  and `wrangler r2 object delete` to reach a *deployed* world, using\n" +
      "  your own `wrangler login` session — no separate token to configure.\n" +
      "  A local world moderates nothing — `permissiveModerator` publishes\n" +
      "  every upload, so nothing is ever left pending to review.\n" +
      "\n" +
      "  --env ENV selects which wrangler.toml environment to target (e.g.\n" +
      "  'preview'); omit it for the top-level (production) database.\n" +
      "  --bucket NAME overrides the R2 bucket, default nullheim-images.\n",
  );
  process.exit(2);
}

/** Runs one sweep of `Engine.reapImages`, then exits. */
async function reap(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" } } });
  const dbPath = values.db ?? ":memory:";
  const { openSqlite } = await import("./db/sqlite.ts");
  const { SCHEMA_SQL } = await import("./db/schema.node.ts");
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

/** Wraps `text` in an OSC 8 terminal hyperlink to `url` — clickable, and immune to line-wrap. */
function hyperlink(url: string, text: string): string {
  return `]8;;${url}${text}]8;;`;
}

/** The account id `dash.cloudflare.com` URLs are addressed under. */
async function resolveAccountId(): Promise<string> {
  const { stdout, code } = await runWrangler(["whoami", "--json"]);
  const info = code === 0 ? (JSON.parse(stdout) as { accounts?: { id: string }[] }) : null;
  const accountId = info?.accounts?.[0]?.id;
  if (!accountId) {
    throw new Error("could not resolve the Cloudflare account id from `wrangler whoami`");
  }
  return accountId;
}

/** The dashboard URL a human can open to view one R2 object directly. */
function dashboardImageUrl(accountId: string, bucket: string, key: string): string {
  return `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${bucket}/objects/${key}/details`;
}

async function moderate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: "string" },
      bucket: { type: "string" },
      list: { type: "boolean", default: false },
      approve: { type: "string" },
      reject: { type: "string" },
    },
  });
  const bucket = values.bucket ?? "nullheim-images";
  const db = openD1Wrangler({ database: "DB", ...(values.env !== undefined && { env: values.env }) });
  const store = new WorldStore(db);
  const engine = new Engine({
    store,
    registry: new Registry(db),
    prompts: loadPrompts(),
    images: openR2Wrangler({ bucket }),
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
    const rows = await store.listImages("pending");
    if (rows.length === 0) {
      console.log("nothing to show");
    }
    const accountId = rows.length > 0 ? await resolveAccountId() : "";
    for (const row of rows) {
      const score = row.score === null ? "" : `  score=${row.score}`;
      const url = dashboardImageUrl(accountId, bucket, row.imageKey);
      console.log(hyperlink(url, `${row.imageKey}  claim=${row.claimId}${score}`));
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

  const { openSqlite } = await import("./db/sqlite.ts");
  const { SCHEMA_SQL } = await import("./db/schema.node.ts");
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
