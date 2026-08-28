#!/usr/bin/env node
/** Command line entry point: `node src/cli.ts serve`. */

import { parseArgs } from "node:util";

import { SCHEMA_SQL } from "./db/schema.node.ts";
import { openSqlite } from "./db/sqlite.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import { listen, makeServer } from "./node-server.ts";
import { loadPrompts } from "./prompts.node.ts";
import {
  DEFAULT_CLAIMS_PER_HOUR,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_LEASE_SECONDS,
  Registry,
} from "./registry.ts";
import { WorldStore } from "./store.ts";

function usage(): never {
  process.stderr.write(
    "usage: nullheim serve [--host HOST] [--port PORT] [--db PATH] " +
      "[--lease-seconds N] [--cooldown-seconds N] [--claims-per-hour N]\n" +
      "\n" +
      "  --db PATH            local SQLite file (defaults to an in-memory world)\n" +
      "  --claims-per-hour N  cap new sectors world-wide (0 disables the cap)\n",
  );
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
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
    },
  });

  const host = values.host!;
  const port = Number(values.port);
  const dbPath = values.db ?? ":memory:";
  const leaseSeconds = Number(values["lease-seconds"]);
  const cooldownSeconds = Number(values["cooldown-seconds"]);
  const claimsPerHour = Number(values["claims-per-hour"]);

  const db = openSqlite(dbPath);
  await db.exec(SCHEMA_SQL);
  const store = new WorldStore(db);
  const registry = new Registry(db, { leaseSeconds, cooldownSeconds, claimsPerHour });
  await ensureGenesis(store);
  const engine = new Engine({ store, registry, prompts: loadPrompts() });

  const server = makeServer(engine);
  const address = await listen(server, host, port);

  console.log(
    `The Nullheim serving on http://${address.host}:${address.port}  ` +
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
