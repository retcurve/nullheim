-- Adds `use_text` to objects and the new `interactions` table.
--
-- 0001_init.sql and 0002_add_image.sql already ran against production D1, so
-- the base tables cannot be edited in place — this is a genuine third
-- migration, not a correction folded back into an earlier one.
-- src/db/schema.sql (the file that seeds a fresh local SQLite database
-- directly) already has both in their final shape; this file's only job is
-- bringing an already-migrated D1 database to that same shape.

ALTER TABLE objects ADD COLUMN use_text TEXT;

CREATE TABLE IF NOT EXISTS interactions (
  interaction_id TEXT PRIMARY KEY,
  object_a_id TEXT NOT NULL,
  object_b_id TEXT NOT NULL,
  text TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_pair ON interactions (object_a_id, object_b_id);
