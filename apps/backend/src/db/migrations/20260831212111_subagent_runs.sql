-- Subagent runs: one persona turn delegating to a second model, bound to a
-- thread anchored on the `subagent:created` card in the parent stream.
-- Workflow state, not a domain entity (INV-57): the conversation itself lives
-- in the thread's messages.

CREATE TABLE IF NOT EXISTS subagent_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    parent_stream_id TEXT NOT NULL,
    parent_session_id TEXT,
    trigger_message_id TEXT,
    card_event_id TEXT NOT NULL,
    thread_stream_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    model TEXT NOT NULL,
    created_by TEXT NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    status_note TEXT,
    result_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live subagent per parent stream, decided by the index rather than by a
-- read-then-write (INV-20): a second concurrent create loses on unique
-- violation instead of both committing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_runs_one_active
    ON subagent_runs (parent_stream_id) WHERE status = 'active';

-- Every turn in a subagent thread resolves its pinned model through this.
CREATE INDEX IF NOT EXISTS idx_subagent_runs_thread
    ON subagent_runs (thread_stream_id);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_workspace
    ON subagent_runs (workspace_id, created_at DESC);
