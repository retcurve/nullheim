/**
 * The storage abstraction that lets the same engine run against a local
 * SQLite file and against Cloudflare D1.
 *
 * D1's own binding shape (`prepare(sql).bind(...).run()/.first()/.all()`) is
 * the one that cannot be adapted away — it is imposed by the platform — so
 * this interface is modelled on it directly rather than on node:sqlite's.
 * `src/db/d1.ts` is close to a pass-through; `src/db/sqlite.ts` is the
 * adapter that does real work, wrapping node:sqlite's synchronous calls in
 * resolved promises so callers never need to know which backend they have.
 *
 * Every write that has to happen atomically — the static lock on a sector,
 * the frontier update that rides along with it, the world-wide claim rate —
 * is expressed as a single statement (via a conditional `INSERT … SELECT …
 * WHERE`) or as one `batch()` call, never as a read followed by a separate
 * write. Both D1 and node:sqlite execute a single statement, and a single
 * `batch()`, as one atomic unit; splitting a check-then-act across two
 * separate `run()` calls would reopen exactly the race this buys safety from.
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

/**
 * Both SQLite dialects report a primary-key or unique-index collision this
 * way. Used to turn "the row already exists" into a typed refusal (like
 * `AlreadyBaked`) instead of a raw database error leaking past the storage
 * layer.
 */
export function isUniqueViolation(exc: unknown): boolean {
  const message = exc instanceof Error ? exc.message : String(exc);
  return message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT");
}
