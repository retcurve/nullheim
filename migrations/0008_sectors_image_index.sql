-- Adds a partial index on sectors.image, covering only the non-null rows.

CREATE INDEX IF NOT EXISTS idx_sectors_image ON sectors (image) WHERE image IS NOT NULL;
