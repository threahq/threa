-- Reverse of the junction's primary key: the messages a preview appears in. The
-- favicon route walks from a host's previews to their messages.
--
-- Standalone single-statement file so CONCURRENTLY works: the migration runner
-- runs a multi-statement file as one implicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_link_previews_ws_preview
  ON message_link_previews (workspace_id, link_preview_id);
