-- Index the one column two different questions now ask about.
--
-- "Is this image referenced by a sector?" is asked on every uncached read of
-- /v1/images/{id} — it decides whether the response may be cached for a year
-- (a referenced image is permanent) or must not be cached at all (an
-- unreferenced one may be deleted by the next reaper sweep). The reaper asks
-- the same question, once per candidate, in its NOT EXISTS.
--
-- Partial, because the overwhelming majority of sectors carry no image and a
-- NULL never answers either question.

CREATE INDEX IF NOT EXISTS idx_sectors_image ON sectors (image) WHERE image IS NOT NULL;
