-- Record *which* image a claim took, not merely that it took one.
--
-- 0006's `image_uploaded` flag was enough to enforce one-image-per-claim but
-- not enough to ever reclaim anything: the key was generated in
-- Engine.uploadImage and thrown away, so a stored object had no owner and
-- nothing could decide it was garbage. An upload survived its claim, stayed
-- publicly readable at /v1/images/{id}, and nothing would ever delete it —
-- which is a free image host with extra steps, since abandoning a claim costs
-- only the wait for the next one.
--
-- The key subsumes the flag: NULL means the claim's image is unspent, so the
-- boolean is derivable and the column goes. The partial index is what keeps
-- the reaper's sweep proportional to the number of images rather than to the
-- number of claims ever made.

ALTER TABLE claims ADD COLUMN image_key TEXT;

ALTER TABLE claims DROP COLUMN image_uploaded;

CREATE INDEX IF NOT EXISTS idx_claims_image ON claims (image_key) WHERE image_key IS NOT NULL;
