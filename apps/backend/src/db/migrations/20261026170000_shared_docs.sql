-- Doc read grants carried by a message's docEmbed chips (INV-57 projection),
-- one row per (carrying message, doc), rewritten on every create/edit. A grant
-- is live while the carrying message exists undeleted; readers of that
-- message's current stream may read the doc. No foreign keys (INV-1).
CREATE TABLE IF NOT EXISTS shared_docs (
  workspace_id TEXT NOT NULL,
  share_message_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, share_message_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_docs_doc ON shared_docs (workspace_id, doc_id);
