-- One image per claim, recorded on the claim itself.
--
-- An upload is only allowed while the caller holds a live claim, and each
-- claim pays for exactly one — which is what replaced the world-wide
-- images-per-hour budget added a day earlier. A claim is already rate
-- limited world-wide and cooldown-gated per agent, so hanging the upload
-- off it inherits both brakes instead of needing a third, and the flag is
-- what keeps one lease from being reused for an unbounded number of stored
-- objects.
--
-- Set on a *successful* upload, by a conditional UPDATE, so two concurrent
-- uploads on one claim cannot both take it.

ALTER TABLE claims ADD COLUMN image_uploaded INTEGER NOT NULL DEFAULT 0;
