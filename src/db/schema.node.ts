/**
 * Reads `schema.sql` from disk as a string.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_SQL = readFileSync(join(import.meta.dirname, "schema.sql"), "utf-8");
