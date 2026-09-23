-- Inbox arrival floor: the read frontier just before a hold began, so bootstrap
-- can find the first other-author message that crossed it. NULL means "held
-- from the start" (no prior read) or "not held".
ALTER TABLE stream_read_state ADD COLUMN inbox_floor_event_id TEXT;
