-- Stash is a durable, synced statement: a
-- stashed draft must not be advertised or auto-restored by any surface on any
-- device until the user takes it back out. Nullable, no default, no index —
-- read paths filter client-side.
ALTER TABLE drafts ADD COLUMN stashed_at TIMESTAMPTZ;
