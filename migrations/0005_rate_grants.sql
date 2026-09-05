-- Replaces `claim_grants` with `rate_grants`, which adds a `kind` column so
-- one table can track rate-limit grants of any kind, not just claims.
-- Copies the existing claim grants across, then drops the old table.

CREATE TABLE IF NOT EXISTS rate_grants (
  kind TEXT NOT NULL,
  granted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_grants_at ON rate_grants (kind, granted_at);

INSERT INTO rate_grants (kind, granted_at) SELECT 'claim', granted_at FROM claim_grants;

DROP TABLE claim_grants;
