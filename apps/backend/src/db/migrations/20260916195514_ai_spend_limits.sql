-- Hard AI spend limits, enforced before every AI call.
--
-- A workspace's effective limit is the lower of its admin-set monthly budget
-- and the operator ceiling, which workspace admins cannot raise. Stages stop at
-- fixed fractions of that limit (agents first, embeddings last). Per-user
-- limits apply to calls attributed to that user.
--
-- degradation_enabled, hard_limit_enabled and hard_limit_percent are no longer
-- read; they are dropped once no deployed replica selects them.

ALTER TABLE ai_budgets
  ADD COLUMN ai_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN operator_ceiling_usd NUMERIC(10, 2) NOT NULL DEFAULT 100.00,
  ADD COLUMN operator_ai_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN default_user_agent_allowance_usd NUMERIC(10, 2);

-- monthly_quota_usd is the user's total-AI maximum.
ALTER TABLE ai_user_quotas
  ADD COLUMN agent_allowance_usd NUMERIC(10, 2),
  ADD COLUMN ai_disabled BOOLEAN NOT NULL DEFAULT false;

