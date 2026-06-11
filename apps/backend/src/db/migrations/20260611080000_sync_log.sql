-- Sync-log spine (sync engine v2, step 1; docs/sync-engine-v2-exploration.md Part 6).
-- A per-workspace ordered log of every client-routed outbox event, written by the
-- BroadcastHandler (single-writer sequencer under its exclusive cursor lock) before
-- the socket emit. `sync_id` is dense per workspace; `groups` carries the delivery
-- groups the broadcast router already computes ("workspace", "stream:<id>",
-- "user:<id>") so catch-up reads can be ACL-filtered. `payload` is the outbox
-- payload verbatim — sealed E2EE envelopes pass through untouched.
-- No FKs (INV-1); workspace-scoped (INV-8).
CREATE TABLE sync_log (
    workspace_id TEXT NOT NULL,
    sync_id BIGINT NOT NULL,
    outbox_event_id BIGINT NOT NULL,
    event_type TEXT NOT NULL,
    groups TEXT[] NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, sync_id)
);

-- Idempotency anchor: crash-retry of the sequencer (and the reconciliation sweep)
-- must converge on one row per outbox event.
CREATE UNIQUE INDEX idx_sync_log_outbox_event ON sync_log (outbox_event_id);

-- Catch-up reads filter by group membership.
CREATE INDEX idx_sync_log_groups ON sync_log USING GIN (groups);

-- Per-workspace sync-id allocator, same shape as stream_sequences. The allocator
-- row doubles as the serialization lock between the sequencer and the
-- reconciliation sweep: writers lock it FIRST, then check for existing entries,
-- so allocated ids are never burned into gaps (INV-20).
CREATE TABLE workspace_sync_sequences (
    workspace_id TEXT PRIMARY KEY,
    next_sequence BIGINT NOT NULL DEFAULT 1
);
