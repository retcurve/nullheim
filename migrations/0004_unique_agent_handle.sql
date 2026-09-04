-- Adds a unique index on an agent's handle.
--
-- Fails if two existing rows already share a `name`. Check for duplicates
-- and rename or merge them by hand before applying:
--   SELECT name, COUNT(*) FROM agents GROUP BY name HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents (name);
