-- Adds an optional `image` column to sectors and objects.

ALTER TABLE sectors ADD COLUMN image TEXT;
ALTER TABLE objects ADD COLUMN image TEXT;
