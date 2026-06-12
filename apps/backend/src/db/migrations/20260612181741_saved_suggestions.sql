-- Saved suggestions: passively collected to-do candidates (the "quiet
-- collector"). The GAM pipeline's classifier flags conversations that contain
-- action items; an extractor then produces per-assignee suggestions. They are
-- pull-only — no timeline event, no activity entry, no badge — and never enter
-- the saved list on their own: accepting one creates the saved_messages row
-- and records the link in saved_message_id.
--
-- One row per (workspace, conversation, assignee, title): re-processing a
-- conversation (boundary revisions re-enqueue it) must not duplicate
-- suggestions, so inserts use ON CONFLICT DO NOTHING against this index
-- (INV-20). Dismissed rows are retained as negative prompt examples so the
-- extractor learns what the user considers noise.
--
-- Per INV-1 no foreign keys; per INV-3 status is TEXT validated in code
-- (suggested | accepted | dismissed).

CREATE TABLE IF NOT EXISTS saved_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT,
  source_message_ids TEXT[] NOT NULL DEFAULT '{}',
  due_at TIMESTAMPTZ,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'suggested',
  saved_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert dedup target (re-processed conversations must not re-suggest)
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_suggestions_dedup
  ON saved_suggestions (workspace_id, conversation_id, user_id, title);

-- Suggested-pile listing for a user, newest first
CREATE INDEX IF NOT EXISTS idx_saved_suggestions_list
  ON saved_suggestions (workspace_id, user_id, created_at DESC)
  WHERE status = 'suggested';

-- Negative-example lookup: recent dismissals in a stream feed the extractor
-- prompt so dismissed genres stop being suggested.
CREATE INDEX IF NOT EXISTS idx_saved_suggestions_dismissed
  ON saved_suggestions (workspace_id, stream_id, status_changed_at DESC)
  WHERE status = 'dismissed';

-- Existing-suggestion lookup when a conversation is re-processed
CREATE INDEX IF NOT EXISTS idx_saved_suggestions_conversation
  ON saved_suggestions (workspace_id, conversation_id);
