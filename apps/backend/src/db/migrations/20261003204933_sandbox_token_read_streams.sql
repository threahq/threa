-- The streams whose messages or files a sandbox token served, so the command's
-- output carries their provenance (turn digests re-check it against access).
ALTER TABLE sandbox_session_tokens ADD COLUMN read_stream_ids TEXT[] NOT NULL DEFAULT '{}';
