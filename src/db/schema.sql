-- Nullheim world schema, run against local SQLite by the Node CLI. A copy
-- of this lives in migrations/0001_init.sql for D1.
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
  image TEXT,
  baked_at REAL NOT NULL,
  PRIMARY KEY (x, y)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sectors_sector_id ON sectors (sector_id);

-- Indexes the non-null image values on sectors.
CREATE INDEX IF NOT EXISTS idx_sectors_image ON sectors (image) WHERE image IS NOT NULL;

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
  image TEXT,
  use_text TEXT,
  agent_id TEXT NOT NULL,
  created_at REAL NOT NULL
);

-- Indexes objects by coordinate, then by creation order.
CREATE INDEX IF NOT EXISTS idx_objects_coordinate ON objects (x, y, created_at);

-- A `use A with B` interaction between two objects. object_a_id and
-- object_b_id are always stored with the lexicographically smaller id
-- first, so the unique index below makes a given pair write-once.
CREATE TABLE IF NOT EXISTS interactions (
  interaction_id TEXT PRIMARY KEY,
  object_a_id TEXT NOT NULL,
  object_b_id TEXT NOT NULL,
  text TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_pair ON interactions (object_a_id, object_b_id);

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
-- Makes an agent's handle unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents (name);

-- `image_key` names the image a claim's one upload took, or is NULL if it
-- hasn't uploaded one yet. `draft` is the most recently submitted,
-- not-yet-baked sector, and carries no lease of its own — it lapses when
-- the claim itself does (`expires_at`, above).
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  attempts INTEGER NOT NULL,
  image_key TEXT,
  genre TEXT NOT NULL,
  size TEXT NOT NULL,
  mood TEXT NOT NULL,
  draft TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_agent ON claims (agent_id, status);
-- Indexes claims by coordinate and status.
CREATE INDEX IF NOT EXISTS idx_claims_coordinate ON claims (x, y, status);
-- Indexes the non-null image keys on claims.
CREATE INDEX IF NOT EXISTS idx_claims_image ON claims (image_key) WHERE image_key IS NOT NULL;

-- One row per grant against a rate-limit budget. `kind` names which budget:
-- 'claim' or 'registration'.
CREATE TABLE IF NOT EXISTS rate_grants (
  kind TEXT NOT NULL,
  granted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_grants_at ON rate_grants (kind, granted_at);

-- What a classifier (or a human reviewer) decided about an uploaded image.
CREATE TABLE IF NOT EXISTS images (
  image_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'published' | 'pending' | 'rejected'
  score REAL,
  created_at REAL NOT NULL,
  reviewed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_images_state ON images (state, created_at);
