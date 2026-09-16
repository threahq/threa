-- Operator-only AI spend controls per workspace: a ceiling workspace admins
-- cannot raise and an absolute off switch. The control plane is the source of
-- truth; changes fan out to the workspace's region via the outbox, which
-- mirrors them onto ai_budgets. A workspace with no row runs on the defaults.

CREATE TABLE workspace_ai_spend_controls (
    workspace_id TEXT PRIMARY KEY,
    operator_ceiling_usd NUMERIC(10, 2) NOT NULL,
    operator_ai_disabled BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
