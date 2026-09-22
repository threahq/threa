-- Inbox hold: a stream stays in the sidebar Inbox after it's read, until the
-- user explicitly clears it. Defaults false and no backfill — every existing
-- row starts uncleared/unheld, matching "nothing held" for pre-existing reads.
ALTER TABLE stream_read_state ADD COLUMN inbox_held BOOLEAN NOT NULL DEFAULT false;
