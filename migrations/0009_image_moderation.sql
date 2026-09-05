-- Adds an `images` table recording each upload's moderation state:
-- 'published', 'pending', or 'rejected'.
CREATE TABLE IF NOT EXISTS images (
  image_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'published' | 'pending' | 'rejected'
  score REAL,
  created_at REAL NOT NULL,
  reviewed_at REAL
);

-- Indexes images by state and creation time.
CREATE INDEX IF NOT EXISTS idx_images_state ON images (state, created_at);
