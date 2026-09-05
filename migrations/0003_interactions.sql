-- Adds `use_text` to objects and a new `interactions` table.

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
