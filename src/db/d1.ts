/**
 * A `Db` backed by the D1 binding.
 */

// D1Database and D1PreparedStatement are ambient globals from
// @cloudflare/workers-types, used unimported.

import type { Db, DbResult, Statement } from "../db.ts";

function toDbResult(meta: { changes: number; last_row_id: number }): DbResult {
  return { changes: meta.changes, lastInsertRowid: meta.last_row_id };
}

function bound(d1: D1Database, statement: Statement): D1PreparedStatement {
  return d1.prepare(statement.sql).bind(...(statement.params ?? []));
}

export function openD1(d1: D1Database): Db {
  return {
    async run(sql, params = []) {
      const res = await bound(d1, { sql, params }).run();
      return toDbResult(res.meta);
    },
    async first<T>(sql: string, params: readonly unknown[] = []) {
      return (await bound(d1, { sql, params }).first()) as T | null;
    },
    async all<T>(sql: string, params: readonly unknown[] = []) {
      const res = await bound(d1, { sql, params }).all();
      return res.results as T[];
    },
    async batch(statements: readonly Statement[]) {
      const results = await d1.batch(statements.map((s) => bound(d1, s)));
      return results.map((r) => toDbResult(r.meta));
    },
    async exec(sql: string) {
      // Runs statements separated by "\n"; does not accept bound parameters.
      await d1.exec(sql);
    },
  };
}
