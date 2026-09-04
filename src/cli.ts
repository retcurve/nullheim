#!/usr/bin/env node
/** Command line entry point: `node src/cli.ts serve`. */

import { parseArgs } from "node:util";

import { SCHEMA_SQL } from "./db/schema.node.ts";
import { openSqlite } from "./db/sqlite.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import { openFsImages } from "./images/fs.ts";
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
      "  problem worth a scheduler.\n",
  );
  process.exit(2);
}

/**
 * One sweep of `Engine.reapImages`, then exit — the local stand-in for the
 * Worker's cron trigger. Bounded and idempotent, so running it twice is
 * harmless and running it never costs only disk.
 */
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
  });
  const { deleted } = await engine.reapImages();
  console.log(`reaped ${deleted} abandoned image(s)`);
  db.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "reap") {
    return reap(rest);
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
  // Nothing durable to write images alongside an in-memory world either —
  // see images/fs.ts.
  const imagesDir = dbPath === ":memory:" ? null : `${dbPath}.images`;
  const engine = new Engine({
    store,
    registry,
    prompts: loadPrompts(),
    images: openFsImages(imagesDir),
    codecs: loadCodecs(),
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
    // Guarded against re-entry: server.close() only drains connections that
    // finish on their own, so an open keep-alive socket (a browser tab left
    // on /enter is enough) can leave it waiting indefinitely. Signalling again
    // is the natural reaction to a shutdown that appears to hang — and
    // without this guard, each repeat call to server.close() stacks another
    // 'close' listener on the server rather than doing anything new, which is
    // how you get Node's own MaxListenersExceededWarning shouting about it.
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
