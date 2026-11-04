-- Bootstrap unread counts count each stream's message_created events per
-- membership, filtered by workspace (INV-8). idx_stream_events_message_seq lacks
-- workspace_id, so every counted event costs a heap fetch; leading with it lets
-- the count run as an index-only scan instead of re-reading the table.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- runs a multi-statement file as one implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stream_events_ws_message_seq
  ON stream_events (workspace_id, stream_id, sequence)
  WHERE event_type = 'message_created';
