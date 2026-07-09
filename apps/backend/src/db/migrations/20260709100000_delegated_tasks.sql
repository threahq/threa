-- Delegated tasks (roadmap 5.1) — durable, lifecycle-tracked hand-offs from a
-- companion turn to the user's local agent. Threa compiles the brief (it has
-- the workspace context); the local agent executes (it has the repo, the
-- filesystem, and the user's credentials). This is a tracking table (INV-57):
-- no state lives on messages, and the timeline card renders from the
-- delegation:created event, patched by delegation:status_changed.
--
-- Status is TEXT constrained in application code by DELEGATION_STATUSES
-- ('open' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' |
-- 'expired'), per INV-3. Every transition is CAS-guarded on the prior status
-- (INV-20) — claim-vs-cancel races resolve to exactly one winner.
--
-- claim_token_hash stores the sha256 of the claim token handed to the claiming
-- agent (the 5.3 public API), never the cleartext — a DB read can't yield an
-- impersonating value (same rule as agent_sessions.callback_token_hash).
-- claim_expires_at bounds a claim; the expiry sweep CASes lapsed claims to
-- 'expired'. created_by/claimed_by are application-enforced references (INV-1
-- no FKs); session_id is nullable because people can delegate manually later,
-- and source_conversation_id anchors the card to a topic for board lenses.
CREATE TABLE IF NOT EXISTS delegated_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  session_id TEXT,
  source_conversation_id TEXT,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  context_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  claim_token_hash TEXT,
  claim_expires_at TIMESTAMPTZ,
  claimed_by_label TEXT,
  result_message_id TEXT,
  status_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The 5.3 claim path lists a workspace's open delegations, oldest first; the
-- partial predicate keeps the index to the claimable set.
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_open
  ON delegated_tasks (workspace_id, created_at)
  WHERE status = 'open';

-- The expiry sweep scans lapsed claims across workspaces.
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_claim_expiry
  ON delegated_tasks (claim_expires_at)
  WHERE status IN ('claimed', 'running');

-- Stream-scoped listing (card backfill, per-stream admin).
CREATE INDEX IF NOT EXISTS idx_delegated_tasks_stream
  ON delegated_tasks (workspace_id, stream_id, created_at DESC);
