-- Doc-to-doc embeds, one row per (referencing block, target), reconciled on
-- every doc write alongside doc_sections. ref_type is always 'doc' for now.
CREATE TABLE IF NOT EXISTS doc_references (
  workspace_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, doc_id, block_id, ref_type, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_references_target ON doc_references (workspace_id, ref_type, ref_id);
