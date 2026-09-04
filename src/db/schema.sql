-- Nullheim world schema.
--
-- Portable SQLite: this file is run verbatim against a local file by the Node
-- CLI (via node:sqlite's exec()) and is also the source for the D1 migration
-- in migrations/0001_init.sql. Keep the two in sync — drift.test.ts does not
-- reach into SQL, so this one is checked by hand.
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
  image TEXT,
  baked_at REAL NOT NULL,
  PRIMARY KEY (x, y)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sectors_sector_id ON sectors (sector_id);

-- Answers "is this image referenced by a sector?", which decides both how
-- long GET /v1/images/{id} may be cached and whether the reaper may delete
-- the object. Partial: most sectors carry no image, and a NULL answers
-- neither question.
CREATE INDEX IF NOT EXISTS idx_sectors_image ON sectors (image) WHERE image IS NOT NULL;

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
  image TEXT,
  use_text TEXT,
  agent_id TEXT NOT NULL,
  created_at REAL NOT NULL
);

-- Every read on the player's path (a room view, an agent's own object tree)
-- is "everything at this coordinate, oldest first" or a further filter by
-- parent_id over that same set, so the index leads with the coordinate.
CREATE INDEX IF NOT EXISTS idx_objects_coordinate ON objects (x, y, created_at);

-- A `use A with B` interaction between two objects. Order-independent by
-- convention — object_a_id and object_b_id are always stored with the
-- lexicographically smaller id first (WorldStore.addInteraction() enforces
-- this), so the unique index below is what makes a given pair write-once,
-- the same permanence rule as everything else here, and a lookup never has
-- to try both orderings against two separate rows.
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
-- A handle is chosen once at registration and never changes, so a straight
-- unique index (rather than a normalised/lowercased column) is enough to
-- make it write-once across every agent, the same way idx_sectors_sector_id
-- makes a sector_id write-once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents (name);

-- `image_key` is the whole of the image budget, and the only record of who
-- owns a stored object: an upload needs a live claim, a claim pays for one,
-- and NULL means unspent. Taken by a conditional UPDATE on success
-- (Registry.takeClaimImage), so concurrent uploads on one lease cannot both
-- have it. It is also what lets the reaper decide an image is garbage — see
-- Engine.reapImages().
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  attempts INTEGER NOT NULL,
  image_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_agent ON claims (agent_id, status);
-- Looked up by coordinate when allocating, to find whether an open claim is
-- already sitting on a frontier slot.
CREATE INDEX IF NOT EXISTS idx_claims_coordinate ON claims (x, y, status);
-- Partial, so the reaper's sweep is proportional to how many images exist
-- rather than to how many claims have ever been made.
CREATE INDEX IF NOT EXISTS idx_claims_image ON claims (image_key) WHERE image_key IS NOT NULL;

-- One row per grant against a world-wide hourly budget, so a rate limit can
-- answer "how long until the oldest grant in the window ages out" rather
-- than just "how many". Pruned opportunistically in Registry, not by a
-- trigger.
--
-- `kind` is which budget: 'claim' or 'registration' — the two writes whose
-- cost the world bears rather than the agent. The index leads with it
-- because every read here is "this kind, inside this window".
CREATE TABLE IF NOT EXISTS rate_grants (
  kind TEXT NOT NULL,
  granted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_grants_at ON rate_grants (kind, granted_at);

-- What a classifier decided about an upload, before a human might override
-- it. See migrations/0009_image_moderation.sql for the full reasoning.
CREATE TABLE IF NOT EXISTS images (
  image_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'published' | 'pending' | 'rejected'
  score REAL,
  created_at REAL NOT NULL,
  reviewed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_images_state ON images (state, created_at);
