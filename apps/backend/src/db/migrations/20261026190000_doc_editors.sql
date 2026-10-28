-- Who edited each doc and when they last did (INV-57 projection of
-- doc_updates), upserted in the transaction that stores each authored update.
-- System repairs are not recorded. No foreign keys (INV-1).
CREATE TABLE IF NOT EXISTS doc_editors (
  workspace_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  last_edited_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, doc_id, actor_id)
);
