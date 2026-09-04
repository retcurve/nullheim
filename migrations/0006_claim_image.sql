-- Adds a flag to claims recording whether this claim has already spent its
-- one image upload.

ALTER TABLE claims ADD COLUMN image_uploaded INTEGER NOT NULL DEFAULT 0;
