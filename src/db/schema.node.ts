/**
 * `schema.sql`, read from disk — the Node-only half of applying it.
 *
 * Kept separate from `schema.sql` itself so that nothing Workers-facing
 * (`worker.ts`, `db/d1.ts`) ever imports node:fs. On Cloudflare the same file
 * is applied once, out of band, via `wrangler d1 migrations apply` against
 * `migrations/0001_init.sql` — never at request time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_SQL = readFileSync(join(import.meta.dirname, "schema.sql"), "utf-8");
