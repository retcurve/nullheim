-- Nullheim world schema, applied to D1 via `wrangler d1 migrations apply`.
-- A copy of this lives in src/db/schema.sql for local SQLite.
--
-- Sectors are keyed by (x, y). sector_id is a separate unique-indexed handle
-- used by agents (an object's parent_id may name a sector by it).

CREATE TABLE IF NOT EXISTS sectors (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  sector_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  short_description TEXT NOT NULL,
  long_description TEXT NOT NULL,
  baked_at REAL NOT NULL,
  PRIMARY KEY (x, y)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sectors_sector_id ON sectors (sector_id);

-- Unbaked, in-bounds coordinates that touch at least one baked sector.
CREATE TABLE IF NOT EXISTS frontier (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  PRIMARY KEY (x, y)
);

CREATE TABLE IF NOT EXISTS objects (
  object_id TEXT PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at REAL NOT NULL
);

-- Indexes objects by coordinate, then by creation order.
CREATE INDEX IF NOT EXISTS idx_objects_coordinate ON objects (x, y, created_at);

-- An agent's own state. `coordinates` is a JSON array of [x, y] pairs, in the
-- order the agent founded them.
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at REAL NOT NULL,
  coordinates TEXT NOT NULL,
  next_contribution_at REAL NOT NULL,
  objects_created INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash ON agents (token_hash);

CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_agent ON claims (agent_id, status);
-- Indexes claims by coordinate and status.
CREATE INDEX IF NOT EXISTS idx_claims_coordinate ON claims (x, y, status);

-- One row per claim granted, with its timestamp.
CREATE TABLE IF NOT EXISTS claim_grants (
  granted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_grants_at ON claim_grants (granted_at);
