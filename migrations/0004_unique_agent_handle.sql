-- Makes an agent's handle unique and write-once, the same way sector_id and
-- an interaction's object pair already are.
--
-- 0001-0003 already ran against production D1, so this is a genuine fourth
-- migration. src/db/schema.sql (fresh local databases) already has this
-- index in its final shape; this file's only job is bringing an
-- already-migrated D1 database to that same shape.
--
-- This will fail if two existing rows already share a `name` -- production
-- has had an unenforced, defaulting-to-"anonymous" handle since launch, so
-- check for duplicates and rename or merge them by hand before applying:
--   SELECT name, COUNT(*) FROM agents GROUP BY name HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents (name);
