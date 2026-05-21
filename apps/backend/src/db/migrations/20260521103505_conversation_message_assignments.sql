-- =============================================================================
-- Conversation Message Assignments: join table for (conversation, message)
-- =============================================================================
--
-- Supersedes the conversations.message_ids and conversations.participant_ids
-- arrays. A message can now belong to multiple conversations (one primary, any
-- number of secondaries), and reassignment flips the primary in place.
--
-- Pairs with `docs/plans/conversation-multi-membership-and-reassignment.md`.
--
-- Migration safety: backfill from the existing arrays runs before the columns
-- are dropped, in a single transaction. If any step fails the whole migration
-- rolls back and the old shape stays intact.

BEGIN;

CREATE TABLE conversation_message_assignments (
    id              TEXT PRIMARY KEY,                  -- cma_<ulid>
    workspace_id    TEXT NOT NULL,                     -- INV-8 scoping
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    stream_id       TEXT NOT NULL,                     -- denorm for stream-scoped reads
    is_primary      BOOLEAN NOT NULL,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'initial' | 'reassigned' | 'secondary' | 'merge' | 'backfill' | 'manual'
    -- Validated in code per INV-3.
    reason          TEXT NOT NULL DEFAULT 'initial',
    -- Optional per-row confidence (separate from the conversation's overall
    -- confidence). Useful to spot low-confidence reassignments in the audit
    -- script. NULL means "use the conversation's confidence as a proxy".
    confidence      REAL CHECK (confidence IS NULL OR (confidence BETWEEN 0.0 AND 1.0)),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each message has exactly one primary conversation. Partial unique index lets
-- the same message also live in secondary conversations without colliding.
CREATE UNIQUE INDEX conversation_message_assignments_message_primary
    ON conversation_message_assignments (message_id)
    WHERE is_primary;

-- A (conversation, message) pair appears at most once regardless of primary.
CREATE UNIQUE INDEX conversation_message_assignments_conv_message
    ON conversation_message_assignments (conversation_id, message_id);

-- Most reads: "give me the assignments for this conversation, in order."
CREATE INDEX conversation_message_assignments_conv_assigned
    ON conversation_message_assignments (conversation_id, assigned_at);

-- Stream-scoped reads (e.g. activity audits).
CREATE INDEX conversation_message_assignments_stream
    ON conversation_message_assignments (stream_id);

-- Workspace-scoped reads (memos, GAM).
CREATE INDEX conversation_message_assignments_workspace
    ON conversation_message_assignments (workspace_id);

-- -----------------------------------------------------------------------------
-- Backfill from the existing message_ids array on conversations.
-- Every existing message becomes a primary assignment with reason='backfill',
-- preserving order via ordinality so assigned_at increments monotonically.
-- -----------------------------------------------------------------------------
INSERT INTO conversation_message_assignments (
    id,
    workspace_id,
    conversation_id,
    message_id,
    stream_id,
    is_primary,
    assigned_at,
    reason
)
SELECT
    'cma_' || replace(gen_random_uuid()::text, '-', ''),
    c.workspace_id,
    c.id,
    msg_id,
    c.stream_id,
    TRUE,
    -- Spread assigned_at across the conversation's lifespan so ORDER BY assigned_at
    -- preserves the original array order. created_at + ordinality * 1ms is monotonic
    -- and bounded above by last_activity_at for any reasonable conversation length.
    c.created_at + (ord * INTERVAL '1 millisecond'),
    'backfill'
FROM conversations c
CROSS JOIN LATERAL unnest(c.message_ids) WITH ORDINALITY AS m(msg_id, ord)
ON CONFLICT (conversation_id, message_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Drop the array columns and their GIN indexes — superseded by the join table.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_conversations_messages;
DROP INDEX IF EXISTS idx_conversations_participants;

ALTER TABLE conversations DROP COLUMN message_ids;
ALTER TABLE conversations DROP COLUMN participant_ids;

COMMIT;
