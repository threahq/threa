-- Agent follow-ups — scheduled "check back later" work an agent creates for
-- itself from within a session. Unlike scheduled_messages (user-authored, fires
-- as a real USER message), a follow-up fires by enqueuing a PERSONA_AGENT job so
-- the persona wakes up and runs a turn as itself — it must never author as the
-- user.
--
-- queue_message_id stores the firing queue row's id so the service can cancel it
-- in the same tx as a cancel mutation. The status guard at fire time keeps a
-- stale queue tick that lost the cancel race from double-firing (worker re-CASes
-- status pending → fired).
--
-- source_conversation_id anchors the follow-up to the trigger's primary
-- conversation (best-effort; null when the segmenter hasn't classified it yet),
-- for later board-lens visibility. session_id is the session that created it.
--
-- Per INV-1 we don't declare foreign keys; per INV-3 status is TEXT validated in
-- application code; per INV-8 every read/write filters by workspace_id.

CREATE TABLE IF NOT EXISTS agent_follow_ups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_conversation_id TEXT,
  note TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  queue_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pending-cap count check (INV-8 workspace-scoped) and the per-stream pending
-- listing. The cap counts pending rows for a stream; this partial index keeps
-- that count cheap.
CREATE INDEX IF NOT EXISTS idx_agent_follow_ups_stream_pending
  ON agent_follow_ups (workspace_id, stream_id, scheduled_for ASC)
  WHERE status = 'pending';
