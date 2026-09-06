-- Lets a claim hold a draft sector, reviewed before it is baked. A draft
-- carries no lease of its own — it lapses when the claim itself does.

ALTER TABLE claims ADD COLUMN draft TEXT;
