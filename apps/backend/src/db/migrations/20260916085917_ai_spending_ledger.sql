-- AI spending ledger: operator-owned workspace policy, immutable spend periods,
-- and one row per paid provider attempt (reserved → dispatched → settled).
-- Money is NUMERIC(20,8): exact 8-decimal USD, compared in code as integers.

CREATE TABLE IF NOT EXISTS ai_spending_policies (
    workspace_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL,
    agent_cutoff_usd NUMERIC(20,8) NOT NULL,
    enrichment_cutoff_usd NUMERIC(20,8) NOT NULL,
    core_cutoff_usd NUMERIC(20,8) NOT NULL,
    embedding_cutoff_usd NUMERIC(20,8) NOT NULL,
    operator_ceiling_usd NUMERIC(20,8) NOT NULL,
    emergency_latched BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_spending_periods (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    timezone TEXT NOT NULL,
    settled_usd NUMERIC(20,8) NOT NULL DEFAULT 0,
    committed_usd NUMERIC(20,8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_spending_periods_workspace_start
    ON ai_spending_periods (workspace_id, starts_at);

CREATE TABLE IF NOT EXISTS ai_spending_attempts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    period_id TEXT NOT NULL,
    sponsor_user_id TEXT NOT NULL,
    session_id TEXT,
    operation_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    stage TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_route TEXT NOT NULL,
    max_cost_usd NUMERIC(20,8) NOT NULL,
    state TEXT NOT NULL,
    actual_cost_usd NUMERIC(20,8),
    receipt JSONB,
    dispatched_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_spending_attempts_workspace_idempotency
    ON ai_spending_attempts (workspace_id, idempotency_key);

CREATE INDEX IF NOT EXISTS ai_spending_attempts_workspace_period_state
    ON ai_spending_attempts (workspace_id, period_id, state);
