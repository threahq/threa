-- Reconciliation sweep state (sync engine v2 step 1 hardening;
-- docs/sync-engine-v2-exploration.md Part 6). The sweep periodically scans
-- outbox rows in a settled time window for client-routed events that never
-- reached sync_log (dispatcher skip or crash) and sequences + emits them.
-- `swept_until` only advances past a window once no running transaction
-- predates it, so the swept set is provably frozen.
CREATE TABLE sync_log_sweep_state (
    singleton TEXT PRIMARY KEY DEFAULT 'sweep' CHECK (singleton = 'sweep'),
    swept_until TIMESTAMPTZ NOT NULL
);

-- The sweep scans outbox by commit-time windows (created_at = transaction
-- start, so a frozen window stays frozen).
CREATE INDEX idx_outbox_created_at ON outbox (created_at);
