-- Stores the genre, size and mood on the claim row. They were previously
-- derived from the claim id on every read, which tied the answer to the
-- length and order of the lists in `src/theme.ts`: appending one genre
-- changed the genre of about half of all existing claims.
--
-- Existing rows are backfilled with a fixed placeholder rather than the
-- value they would have derived. Any claim written before this migration
-- predates the world going live.

ALTER TABLE claims ADD COLUMN genre TEXT NOT NULL DEFAULT 'Fantasy';

ALTER TABLE claims ADD COLUMN size TEXT NOT NULL DEFAULT 'Medium';

ALTER TABLE claims ADD COLUMN mood TEXT NOT NULL DEFAULT 'Deadpan';
