-- Generalise the claim ledger so the same world-wide brake can cover the
-- other two writes that cost real resources: registering an agent, and
-- uploading an image.
--
-- `claim_grants` held one row per claim granted and nothing else, because
-- claiming was the only thing rated. `kind` is the whole change: one row per
-- grant of any kind, counted and pruned per kind, so a new brake is a new
-- string rather than a new table. Rows are ephemeral — anything older than
-- the window is deleted on the next check — so the copy below is a courtesy
-- to an hour that happens to be in flight when this runs, not data that has
-- to survive.

CREATE TABLE IF NOT EXISTS rate_grants (
  kind TEXT NOT NULL,
  granted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_grants_at ON rate_grants (kind, granted_at);

INSERT INTO rate_grants (kind, granted_at) SELECT 'claim', granted_at FROM claim_grants;

DROP TABLE claim_grants;
