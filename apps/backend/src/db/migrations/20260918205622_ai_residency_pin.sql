-- Whether this workspace has pinned its AI to models that can be run in its own
-- region. Pinned keeps every AI call on the regionally-runnable registry;
-- unpinned trades that option away for whatever is best on quality, price and
-- latency. Default false: nobody is pinned today, and pinning is the opt-in.
--
-- It sits on ai_budgets because that row is already the workspace's AI policy
-- (ai_disabled, the operator controls). Unlike the operator columns it is
-- workspace-admin-owned, so it has no control-plane mirror.

ALTER TABLE ai_budgets
  ADD COLUMN ai_residency_pinned BOOLEAN NOT NULL DEFAULT false;
