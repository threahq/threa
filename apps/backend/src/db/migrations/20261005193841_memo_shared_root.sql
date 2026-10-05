-- Threa Connect: the shared channel a memo was captured from while its host
-- shared it, read the way the partner reads it. NULL is a memo made outside a share.
ALTER TABLE memos ADD COLUMN shared_root_stream_id TEXT;
