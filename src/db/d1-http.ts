/**
 * D1 over Cloudflare's REST API, so an operator on a developer machine can
 * reach a *deployed* world's database.
 *
 * This exists for exactly one caller — `nullheim moderate`, the human half
 * of image moderation. Moderation is a human-in-the-loop feature, and until
 * this adapter there was no way to operate that half against any deployed
 * world at all: the CLI opened a local SQLite file, and preview and
 * production are D1. A pending image on preview could only be cleared by
 * hand-writing SQL through `wrangler d1 execute`.
 *
 * **Never put this on a request path.** The Worker already has a real D1
 * binding (`./d1.ts`), which is faster, transactional and needs no token.
 * This one is an HTTPS round trip to Cloudflare's control plane per call,
 * authenticated by an account-wide API token, and it is missing a guarantee
 * the binding has — see `batch` below.
 */

import type { Db, DbResult, Statement } from "../db.ts";

export interface D1HttpTarget {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
}

interface QueryResult {
  readonly results?: unknown[];
  readonly success: boolean;
  readonly meta?: { changes?: number; last_row_id?: number };
}

/**
 * A SQL literal, for `batch` alone — every other method sends real bound
 * parameters and never comes near this.
 *
 * Inlining values into SQL is the thing the rest of this codebase refuses to
 * do, so the reason it is here is worth stating plainly: the REST endpoint
 * rejects the combination this adapter would otherwise need. Sending two
 * statements with a `params` array comes back `7400 The request is malformed:
 * params with multiple statements is not supported` (checked against a live
 * database, 2026-09-04). One or the other, not both.
 *
 * The encoding is therefore the whole safety story, and it is deliberately
 * narrow rather than clever: numbers must be finite, strings are single
 * quoted with `''` doubling, and anything else — a Date, an object, a
 * bigint, a Uint8Array — throws rather than being coerced into a shape this
 * function has not thought about. `batch` is only ever reached with values
 * this file's one caller produces (a timestamp and an image key), so the
 * throw is a guard against a future caller, not a case anybody hits today.
 */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot inline a non-finite number: ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`cannot inline a ${typeof value} as a SQL literal`);
}

function inline({ sql, params = [] }: Statement): string {
  let index = 0;
  // Only `?` placeholders outside string literals are substituted. The
  // statements here are this repo's own, which use `?` exclusively and never
  // contain a quoted `?`, so the scan stays this simple on purpose: a parser
  // clever enough to handle the general case would be a parser that can be
  // wrong in ways this one cannot.
  const out = sql.replace(/'(?:[^']|'')*'|\?/g, (match) =>
    match === "?" ? literal(params[index++]) : match,
  );
  if (index !== params.length) {
    throw new Error(`statement has ${index} placeholders but ${params.length} parameters`);
  }
  return out;
}

export function openD1Http(target: D1HttpTarget): Db {
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${target.accountId}` +
    `/d1/database/${target.databaseId}/query`;

  async function query(sql: string, params?: readonly unknown[]): Promise<QueryResult[]> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params === undefined ? { sql } : { sql, params }),
    });
    const body = (await response.json()) as {
      success?: boolean;
      result?: QueryResult[];
      errors?: { code?: number; message?: string }[];
    };
    if (!response.ok || body.success !== true) {
      // The API reports a bad statement as a 200 with `success: false`, so the
      // HTTP status alone is not the check. An auth failure is by far the
      // likeliest error here and says nothing useful on its own, so the status
      // rides along with whatever Cloudflare said.
      const said = body.errors?.map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim()).join("; ");
      throw new Error(`D1 request failed (HTTP ${response.status}): ${said || "no detail given"}`);
    }
    return body.result ?? [];
  }

  function toDbResult(result: QueryResult | undefined): DbResult {
    return {
      changes: result?.meta?.changes ?? 0,
      lastInsertRowid: result?.meta?.last_row_id ?? 0,
    };
  }

  return {
    async run(sql, params = []) {
      return toDbResult((await query(sql, params))[0]);
    },
    async first<T>(sql: string, params: readonly unknown[] = []) {
      const rows = (await query(sql, params))[0]?.results ?? [];
      return (rows[0] as T) ?? null;
    },
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return ((await query(sql, params))[0]?.results ?? []) as T[];
    },

    /**
     * **Not atomic, unlike every other `Db`.** Both real backends run a
     * `batch()` as one unit; this sends one request holding several
     * statements, and Cloudflare does not document that as a transaction.
     * Assume a failure part-way through leaves the earlier statements
     * applied.
     *
     * That is survivable for the one batch this adapter is used for, and it
     * would not be for most of the others, which is the real reason this
     * file must stay off the request path. `WorldStore.rejectImage` marks an
     * image rejected and clears the sector field showing it; a partial apply
     * in either order is invisible to players, because `sectorView` already
     * omits any image that is not `published`, and re-running `--reject`
     * fixes it — both statements are idempotent. Nothing else here would be
     * so lucky: `bake()`'s batch is what makes a sector and its frontier
     * update one event.
     */
    async batch(statements: readonly Statement[]) {
      if (statements.length === 0) return [];
      const results = await query(statements.map(inline).join(";\n"));
      return statements.map((_, i) => toDbResult(results[i]));
    },

    async exec() {
      // Migrations are `wrangler d1 migrations apply`'s job. An operator CLI
      // reaching a deployed database is the last place that should be able to
      // run unbounded DDL by accident, so this refuses rather than obliging.
      throw new Error("exec() is not available over the D1 REST API — use wrangler for migrations");
    },
  };
}
