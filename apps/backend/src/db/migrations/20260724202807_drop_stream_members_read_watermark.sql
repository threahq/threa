-- Post-bake cleanup: stream_read_state is now the sole read watermark truth.
-- Drop the legacy membership watermark columns. Destructive and gated on the
-- compatibility/refresh window having passed (no old binary still dual-writes
-- these). No reverse fallback: read state never lives on stream_members again
-- (membership ≠ access ≠ read state).
ALTER TABLE stream_members
    DROP COLUMN IF EXISTS last_read_event_id,
    DROP COLUMN IF EXISTS last_read_at;
