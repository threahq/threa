-- Live all-time message count per stream. Existing rows stay NULL ("not yet
-- counted") until the stream-message-count backfill recounts them; new streams
-- start at 0. The revision is the optimistic-concurrency version clients use to
-- drop stale snapshots (INV-66).
ALTER TABLE streams ADD COLUMN IF NOT EXISTS message_count INTEGER;
ALTER TABLE streams ALTER COLUMN message_count SET DEFAULT 0;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS message_count_revision INTEGER NOT NULL DEFAULT 0;
