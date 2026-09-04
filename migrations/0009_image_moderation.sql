-- What a classifier decided about an upload, before a human might override it.
--
-- Two verdicts reach a row automatically: 'published' (clean) and 'pending'
-- (unsure, held for a human). There is no automated 'rejected' — see
-- src/moderation.ts's module comment for why an auto-refuse-and-retry third
-- verdict was rejected. 'rejected' is reachable only through a human's own
-- `nullheim moderate --reject`, which is also this world's only takedown
-- path: it works on an already-`published` image too, clearing the blob and
-- the sector field showing it (WorldStore.rejectImage).
--
-- src/images.ts's module comment used to say there was deliberately no
-- metadata table for an image, because "an image is immutable,
-- content-addressed data with nothing to query by". Moderation gives it
-- something to query by, so that reasoning no longer holds — this table is
-- why.
--
-- claims.image_key stays the reaper's own source of truth
-- (Registry.reapableImages is unchanged): this table answers a different
-- question — is this key fit to show? — from the one the reaper asks — can
-- this claim's key still lead anywhere? — so the two are not duplicating one
-- fact under two names.
CREATE TABLE IF NOT EXISTS images (
  image_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'published' | 'pending' | 'rejected'
  score REAL,
  created_at REAL NOT NULL,
  reviewed_at REAL
);

-- The review queue is "state = 'pending', oldest first"; every other read
-- here is a single lookup by the primary key.
CREATE INDEX IF NOT EXISTS idx_images_state ON images (state, created_at);
