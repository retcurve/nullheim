-- Replaces the `image_uploaded` flag with an `image_key` column that
-- records which image the claim took (NULL if none). Adds a partial index
-- over the non-null keys.

ALTER TABLE claims ADD COLUMN image_key TEXT;

ALTER TABLE claims DROP COLUMN image_uploaded;

CREATE INDEX IF NOT EXISTS idx_claims_image ON claims (image_key) WHERE image_key IS NOT NULL;
