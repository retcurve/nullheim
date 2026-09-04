/**
 * The storage abstraction that lets the same engine run against a local
 * SQLite file and against Cloudflare D1.
 *
 * The interface follows D1's own binding shape
 * (`prepare(sql).bind(...).run()/.first()/.all()`). `src/db/d1.ts` is close
 * to a pass-through; `src/db/sqlite.ts` adapts node:sqlite's synchronous
 * calls into resolved promises.
 *
 * Writes that must happen atomically — a sector's static lock and frontier
 * update, the world-wide claim rate — are each expressed as one statement
 * (a conditional `INSERT … SELECT … WHERE`) or one `batch()` call, never as
 * a read followed by a separate write.
 */

export interface DbResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface Statement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export interface Db {
  /** INSERT/UPDATE/DELETE. `changes` is how callers detect a lost race. */
  run(sql: string, params?: readonly unknown[]): Promise<DbResult>;
  /** The first row, or null. */
  first<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null>;
  /** Every matching row. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Every statement succeeds or none do. Results are positional. */
  batch(statements: readonly Statement[]): Promise<DbResult[]>;
  /** Multi-statement DDL. Migrations only — never on the request path. */
  exec(sql: string): Promise<void>;
}

/** True if `exc` is a primary-key or unique-index collision from either SQLite dialect. */
export function isUniqueViolation(exc: unknown): boolean {
  const message = exc instanceof Error ? exc.message : String(exc);
  return message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT");
}
