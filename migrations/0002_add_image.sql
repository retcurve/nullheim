-- Adds the optional `image` (ASCII art) column to sectors and objects.
--
-- 0001_init.sql already ran against production D1, so the base tables it
-- created cannot be edited in place — this is a genuine second migration,
-- not a correction folded back into the first. src/db/schema.sql (the file
-- that seeds a fresh local SQLite database directly) already has `image` in
-- the CREATE TABLE itself, so this file's only job is bringing an
-- already-migrated D1 database to that same final shape.

ALTER TABLE sectors ADD COLUMN image TEXT;
ALTER TABLE objects ADD COLUMN image TEXT;
