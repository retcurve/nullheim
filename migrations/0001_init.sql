-- The Entropic world schema — the D1 migration.
--
-- A copy of src/db/schema.sql, applied here via `wrangler d1 migrations
-- apply`. The Node CLI runs that same file directly (via node:sqlite's
-- exec()) at every local startup instead — there is no separate migration
-- step for local dev. Keep the two files in sync by hand: drift.test.ts does
-- not reach into SQL.
--
-- Coordinates are the primary key everywhere they identify a sector, rather
-- than a synthetic id, because the world is a lattice and "the sector at
-- (x, y)" is already a unique, stable identity. `sector_id` is a separate
-- agent-facing handle (an object's parent_id may name a sector by it) and
-- gets its own unique index rather than being the primary key, so a lookup by
-- coordinate never has to join through it.

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

-- The frontier: unbaked, in-bounds coordinates touching at least one baked
-- sector. Maintained incrementally by WorldStore.bake() — see the comment
-- there — rather than recomputed by scanning every sector on each claim.
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

-- Every read on the player's path (a room view, an agent's own object tree)
-- is "everything at this coordinate, oldest first" or a further filter by
-- parent_id over that same set, so the index leads with the coordinate.
CREATE INDEX IF NOT EXISTS idx_objects_coordinate ON objects (x, y, created_at);

-- An agent's own state. `coordinates` is a JSON array of [x, y] pairs, in the
-- order the agent founded them — small and always read as a whole (an agent
-- view walks every sector it holds), so one JSON column earns its keep over a
-- join table here.
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
-- Looked up by coordinate when allocating, to find whether an open claim is
-- already sitting on a frontier slot.
CREATE INDEX IF NOT EXISTS idx_claims_coordinate ON claims (x, y, status);

-- One row per claim granted, so the world-wide rate limit can answer "how
-- long until the oldest grant in the window ages out" rather than just
-- "how many". Pruned opportunistically in Registry, not by a trigger.
CREATE TABLE IF NOT EXISTS claim_grants (
  granted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_grants_at ON claim_grants (granted_at);
