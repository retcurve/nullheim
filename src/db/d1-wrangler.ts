/**
 * A `Db` implementation that runs each statement through `wrangler d1
 * execute`. Used by `nullheim moderate` to reach a deployed world's
 * database.
 */

import type { Db, DbResult, Statement } from "../db.ts";
import { runWrangler, type WranglerRun } from "../wrangler-cli.ts";

export interface D1WranglerTarget {
  /** The binding or database name wrangler.toml declares — "DB" in this project. */
  readonly database: string;
  /** wrangler's `--env`. Omitted targets the top-level (production) environment. */
  readonly env?: string;
}

interface QueryResult {
  readonly results?: unknown[];
  readonly success: boolean;
  readonly meta?: { changes?: number; last_row_id?: number };
}

/**
 * Renders one value as a SQL literal, used to inline every statement's
 * parameters. Numbers must be finite. Strings are wrapped in single quotes,
 * with each internal quote doubled. Any other type throws.
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

export function openD1Wrangler(target: D1WranglerTarget, run: WranglerRun = runWrangler): Db {
  const envArgs = target.env ? ["--env", target.env] : [];

  async function query(sql: string): Promise<QueryResult[]> {
    const { stdout, stderr, code } = await run([
      "d1",
      "execute",
      target.database,
      "--remote",
      "--json",
      ...envArgs,
      "--command",
      sql,
    ]);
    let body: unknown;
    try {
      body = JSON.parse(stdout);
    } catch {
      throw new Error(`wrangler d1 execute produced no parseable output (exit ${code}): ${stderr || stdout || "(empty)"}`);
    }
    if (!Array.isArray(body)) {
      const err = (body as { error?: { text?: string; notes?: { text?: string }[] } })?.error;
      const detail = [err?.text, ...(err?.notes?.map((n) => n.text) ?? [])].filter(Boolean).join(" — ");
      throw new Error(`wrangler d1 execute failed: ${detail || JSON.stringify(body)}`);
    }
    return body as QueryResult[];
  }

  function toDbResult(result: QueryResult | undefined): DbResult {
    return {
      changes: result?.meta?.changes ?? 0,
      lastInsertRowid: result?.meta?.last_row_id ?? 0,
    };
  }

  return {
    async run(sql, params = []) {
      return toDbResult((await query(inline({ sql, params })))[0]);
    },
    async first<T>(sql: string, params: readonly unknown[] = []) {
      const rows = (await query(inline({ sql, params })))[0]?.results ?? [];
      return (rows[0] as T) ?? null;
    },
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return ((await query(inline({ sql, params })))[0]?.results ?? []) as T[];
    },

    /** Sends all statements inlined into a single command, joined by semicolons. Not atomic. */
    async batch(statements: readonly Statement[]) {
      if (statements.length === 0) return [];
      const results = await query(statements.map(inline).join(";\n"));
      return statements.map((_, i) => toDbResult(results[i]));
    },

    async exec() {
      throw new Error("exec() is not available here — use `wrangler d1 migrations apply` for migrations");
    },
  };
}
