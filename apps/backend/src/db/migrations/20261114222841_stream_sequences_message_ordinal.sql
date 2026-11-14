-- Each stream's message ordinal (its message_created event count), maintained
-- by event allocation and moves. NULL means not counted yet; no default, so a row an old-code
-- replica inserts during rollout stays NULL until the stream-message-ordinal
-- backfill counts it.
ALTER TABLE stream_sequences ADD COLUMN IF NOT EXISTS message_ordinal INTEGER;
