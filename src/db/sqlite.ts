/**
 * Local storage: node:sqlite, wrapped to the same `Db` shape as D1.
 *
 * node:sqlite is synchronous; every method here returns a resolved promise
 * to match the async `Db` interface.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { Db, DbResult, Statement } from "../db.ts";

export interface SqliteDb extends Db {
  close(): void;
}

/** Casts bound parameters to the types node:sqlite accepts (string, number, or null). */
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
