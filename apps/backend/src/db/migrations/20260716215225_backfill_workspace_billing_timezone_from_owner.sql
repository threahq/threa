-- Give existing workspaces their owner's timezone as the AI-spend billing boundary.
--
-- `billingTimezone` (workspace_setting_overrides) decides where the AI budget's
-- month is cut — both what the dashboard reports and the window
-- budget-service.checkBudget enforces. New workspaces seed it from the owner at
-- setup completion; workspaces created before that land on the "UTC" code
-- default, which is nobody's actual boundary.
--
-- workspaces.created_by holds the owner's users.id (not the WorkOS id). Owners
-- whose timezone was never reported keep the UTC default and can set it in
-- workspace settings.
--
-- DO NOTHING, not DO UPDATE: a workspace that already chose a zone must keep it.

INSERT INTO workspace_setting_overrides (workspace_id, key, value)
SELECT w.id, 'billingTimezone', to_jsonb(u.timezone)
FROM workspaces w
JOIN users u ON u.id = w.created_by AND u.workspace_id = w.id
WHERE u.timezone IS NOT NULL
  AND u.timezone <> ''
ON CONFLICT (workspace_id, key) DO NOTHING;
