-- Control-plane auth_log — a durable, queryable record of authentication-surface
-- access events. Global scope (no workspace sharding — INV-8's global infra/auth
-- exception), primarily fed by the WorkOS Events API (see
-- apps/control-plane/src/features/auth-log/), with a few own-handler rows for
-- failures WorkOS structurally cannot see (callback-exchange / magic-auth verify).
--
-- Plain (non-partitioned) table, deliberately: idempotent re-ingestion of the
-- replayable Events API relies on a pure `ON CONFLICT (workos_event_id)` upsert.
-- A declarative-partitioned table cannot carry a unique index that omits the
-- partition key, so partitioning would force the conflict target to
-- (occurred_at, workos_event_id) and break event-id idempotency. Auth-event
-- volume is tiny (logins, sessions, membership changes), so a plain table with a
-- batched-DELETE retention worker (13 months) is the honest, simple shape.
--
-- No FKs, no enums (INV-1/3): outcome/event_type are TEXT validated in code.
-- No content ever: IDs, emails (forensic, per §10 decision 5), and content-free
-- detail only — never tokens, codes, or secrets.

CREATE TABLE IF NOT EXISTS auth_log (
    id                  TEXT NOT NULL PRIMARY KEY,          -- alog_<ulid>
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    workos_event_id     TEXT,                               -- NULL for own-handler rows
    event_type          TEXT NOT NULL,                      -- WorkOS event type verbatim, or cp.* for own rows
    workos_user_id      TEXT,
    email               TEXT,
    organization_id     TEXT,
    impersonator_email  TEXT,
    ip                  INET,
    user_agent          TEXT,
    outcome             TEXT NOT NULL,                      -- 'success' | 'denied'
    detail              JSONB,
    -- Ingestion time; occurred_at is the event time at WorkOS. The gap between
    -- the two is the ingestion lag — forensically relevant when establishing
    -- what we knew when.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent re-ingestion: WorkOS event ids are globally unique and the Events
-- API is replayable, so a partial unique index (own-handler rows carry no event
-- id) backs the poller's `ON CONFLICT (workos_event_id) DO NOTHING`.
CREATE UNIQUE INDEX IF NOT EXISTS auth_log_workos_event_id_key
    ON auth_log (workos_event_id)
    WHERE workos_event_id IS NOT NULL;

-- Retention sweeps by occurred_at; forensic lookups filter by actor.
CREATE INDEX IF NOT EXISTS auth_log_occurred_at_idx ON auth_log (occurred_at);
CREATE INDEX IF NOT EXISTS auth_log_workos_user_id_idx ON auth_log (workos_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS auth_log_email_idx ON auth_log (email, occurred_at);
