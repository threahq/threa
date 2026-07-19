-- =============================================================================
-- Access log — durable record of trust-boundary crossings (who read/wrote/
-- disclosed what, when, as whom, from where). Content-free: refs and ranges
-- only, never message/memo text. Design: docs/plans/read-access-logging.md.
--
-- First declaratively-partitioned table in the schema (PG 17, RANGE on
-- occurred_at, monthly partitions). Indexes are declared on the parent so
-- every partition inherits them. Ongoing partitions are created/dropped by the
-- PartitionMaintenanceWorker; this migration seeds the current + next month so
-- the table is writable before the worker's first tick.
-- =============================================================================

CREATE TABLE IF NOT EXISTS access_log (
    id                    TEXT NOT NULL,            -- acc_<ulid> (INV-2)
    workspace_id          TEXT,                     -- NULL only for workspace-less auth-surface rows (INV-8 global exception)
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_type            TEXT NOT NULL,            -- 'user' | 'persona' | 'bot' | 'system' (INV-3)
    actor_id              TEXT NOT NULL,
    on_behalf_of_user_id  TEXT,
    auth_ref              TEXT,                     -- uak_/bak_/dlg_/sconn_ ref
    operation             TEXT NOT NULL,
    access_kind           TEXT NOT NULL,            -- 'read' | 'write' | 'subscribe' | 'unsubscribe' | 'disclose'
    outcome               TEXT NOT NULL,            -- 'success' | 'denied' | 'error'
    subjects              JSONB,
    detail                JSONB,
    ip                    INET,
    user_agent            TEXT,
    request_id            TEXT,
    PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS idx_access_log_workspace_occurred
    ON access_log (workspace_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_access_log_actor_occurred
    ON access_log (actor_id, occurred_at);

-- GIN jsonb_path_ops on subjects makes query #2 ("everyone who touched subject
-- Y") a cheap containment (@>) lookup.
CREATE INDEX IF NOT EXISTS idx_access_log_subjects
    ON access_log USING GIN (subjects jsonb_path_ops);

-- Seed the current + next month partitions relative to the migration run time
-- (UTC month boundaries), so a fresh deploy in any month is immediately
-- writable. Idempotent via IF NOT EXISTS; the worker maintains the rest.
DO $$
DECLARE
    month_start DATE := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
    i INT;
    lo DATE;
    hi DATE;
    part TEXT;
BEGIN
    FOR i IN 0..1 LOOP
        lo := month_start + (i || ' months')::interval;
        hi := lo + INTERVAL '1 month';
        part := format('access_log_%s', to_char(lo, 'YYYY_MM'));
        -- +00-anchored literals: boundaries are UTC regardless of session TimeZone.
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF access_log FOR VALUES FROM (%L) TO (%L)',
            part,
            to_char(lo, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(hi, 'YYYY-MM-DD') || ' 00:00:00+00'
        );
    END LOOP;
END $$;
