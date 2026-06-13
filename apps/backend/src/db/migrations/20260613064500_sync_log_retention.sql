-- Sync-log retention (sync engine v2; docs/plans/sync-v2-log-retention.md).
-- The sync_log grows one row per client-routed outbox event forever. The
-- retention worker prunes entries older than the horizon (default 30 days)
-- while always keeping at least the most recent N per workspace, so a quiet
-- workspace's returning client still catches up from the log instead of
-- forcing a full bootstrap.
--
-- A client whose cursor predates the pruned range can no longer replay the
-- gap from the log; `retained_from` is the per-workspace high-water mark of
-- pruned sync ids, and catch-up compares the client's cursor against it to
-- signal `requiresBootstrap` (the client falls back to a full bootstrap, the
-- authority for everything <= head). No FKs (INV-1); workspace-scoped (INV-8).
CREATE TABLE sync_log_retention_state (
    workspace_id TEXT PRIMARY KEY,
    -- Highest sync_id pruned for this workspace. Entries with sync_id <=
    -- retained_from are gone; a cursor strictly below it cannot fully heal
    -- from the log. Monotonic (advanced with GREATEST).
    retained_from BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The pruner selects victims by commit time within each workspace
-- (created_at < cutoff). sync_id is dense per workspace, so the count floor
-- is arithmetic on the head and needs no index; this index serves the
-- time-window scan.
CREATE INDEX idx_sync_log_workspace_created_at ON sync_log (workspace_id, created_at);
