/**
 * Local storage: node:sqlite, wrapped to the same shape D1 hands out.
 *
 * node:sqlite is synchronous — there is no I/O to await, the file is memory
 * mapped and every call blocks for microseconds. The `Promise.resolve` wraps
 * below exist only so callers never have to know that; the same `Engine`
 * built against this adapter or against `db/d1.ts` behaves identically.
 *
 * Still experimental in Node 22 (a warning on import, not on use). It is the
 * only stdlib option that needs no dependency and no native build step for a
 * project with "no runtime dependencies" as a stated goal; better-sqlite3
 * would be the fallback if that warning ever becomes a hard blocker.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { Db, DbResult, Statement } from "../db.ts";

export interface SqliteDb extends Db {
  close(): void;
}

/**
 * Every value this app ever binds is a string, a number, or null (the same
 * three JSON-safe primitives the wire format itself is limited to) — this
 * just says so to the type checker, which knows `SQLInputValue` as a wider
 * type than `unknown` only by name.
 */
function toSqlParams(params: readonly unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

export function openSqlite(path: string): SqliteDb {
  const conn = new DatabaseSync(path);
  if (path !== ":memory:") {
    conn.exec("PRAGMA journal_mode = WAL;");
  }
  conn.exec("PRAGMA foreign_keys = ON;");

  function runInfo(sql: string, params: readonly unknown[]): DbResult {
    const info = conn.prepare(sql).run(...toSqlParams(params));
    return {
      changes: Number(info.changes),
      lastInsertRowid: Number(info.lastInsertRowid),
    };
  }

  return {
    async run(sql, params = []) {
      return runInfo(sql, params);
    },
    async first<T>(sql: string, params: readonly unknown[] = []) {
      return (conn.prepare(sql).get(...toSqlParams(params)) ?? null) as T | null;
    },
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return conn.prepare(sql).all(...toSqlParams(params)) as T[];
    },
    async batch(statements: readonly Statement[]) {
      conn.exec("BEGIN");
      try {
        const results = statements.map((s) => runInfo(s.sql, s.params ?? []));
        conn.exec("COMMIT");
        return results;
      } catch (exc) {
        conn.exec("ROLLBACK");
        throw exc;
      }
    },
    async exec(sql: string) {
      conn.exec(sql);
    },
    close() {
      conn.close();
    },
  };
}
