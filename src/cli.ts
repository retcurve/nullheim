#!/usr/bin/env node
/** Command line entry point: `node src/cli.ts serve`. */

import { parseArgs } from "node:util";

import { listen, makeServer } from "./api.ts";
import {
  DEFAULT_CLAIMS_PER_HOUR,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_LEASE_SECONDS,
} from "./registry.ts";
import { Engine } from "./engine.ts";

function usage(): never {
  process.stderr.write(
    "usage: mosaic serve [--host HOST] [--port PORT] [--state PATH] " +
      "[--lease-seconds N] [--cooldown-seconds N] [--claims-per-hour N]\n" +
      "\n" +
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
      state: { type: "string" },
      "lease-seconds": { type: "string", default: String(DEFAULT_LEASE_SECONDS) },
      "cooldown-seconds": { type: "string", default: String(DEFAULT_COOLDOWN_SECONDS) },
      "claims-per-hour": { type: "string", default: String(DEFAULT_CLAIMS_PER_HOUR) },
    },
  });

  const host = values.host!;
  const port = Number(values.port);
  const statePath = values.state ?? null;
  const leaseSeconds = Number(values["lease-seconds"]);
  const cooldownSeconds = Number(values["cooldown-seconds"]);
  const claimsPerHour = Number(values["claims-per-hour"]);

  const engine = new Engine({ statePath, leaseSeconds, cooldownSeconds, claimsPerHour });
  const server = makeServer(engine);
  const address = await listen(server, host, port);

  console.log(
    `Mosaic serving on http://${address.host}:${address.port}  ` +
      `(${engine.store.count()} sectors, ${engine.store.objectCount()} objects)`,
  );
  console.log(
    `Frontier: ${engine.registry.frontier().length} open sector(s)  |  ` +
      `cooldown ${cooldownSeconds}s  |  ` +
      (claimsPerHour > 0 ? `${claimsPerHour} claims/hour` : "claim rate uncapped"),
  );

  return new Promise((resolve) => {
    // Guarded against re-entry: server.close() only drains connections that
    // finish on their own, so an open keep-alive socket (a browser tab left
    // on /play is enough) can leave it waiting indefinitely. Signalling again
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
        // Fold the log back into the snapshot so the next start is a plain read.
        engine.store.compact();
        engine.store.close();
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
