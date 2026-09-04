/**
 * A `Db` implementation over Cloudflare's D1 REST API. Used by `nullheim
 * moderate` to reach a deployed world's database from a developer machine.
 * Not used on the Worker's own request path, which uses the D1 binding in
 * `./d1.ts` instead. Each call here is an HTTPS request to Cloudflare's
 * control plane, authenticated with an account-wide API token.
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
 * Renders one value as a SQL literal, used only by `batch` below. Numbers
 * must be finite. Strings are wrapped in single quotes, with each internal
 * quote doubled. Any other type throws.
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
  // Replaces each `?` placeholder outside a quoted string literal with its
  // corresponding literal value.
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
      // Checks both the HTTP status and the response body's own `success`
      // field, since the API can report a bad statement as a 200 with
      // `success: false`.
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
     * Sends all statements inlined into a single SQL request, joined by
     * semicolons. Not atomic: a failure part-way through can leave earlier
     * statements applied and later ones not.
     */
    async batch(statements: readonly Statement[]) {
      if (statements.length === 0) return [];
      const results = await query(statements.map(inline).join(";\n"));
      return statements.map((_, i) => toDbResult(results[i]));
    },

    async exec() {
      // Always throws. Migrations must run through `wrangler d1 migrations apply` instead.
      throw new Error("exec() is not available over the D1 REST API — use wrangler for migrations");
    },
  };
}
