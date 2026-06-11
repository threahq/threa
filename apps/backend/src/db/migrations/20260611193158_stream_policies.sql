-- Generalize the per-stream agent tool-privacy policy from E2E scratchpads to
-- ALL streams (agent-runtimes unification Phase 1.4, closing plan findings #8/N-1:
-- the encrypted surface had a per-stream tool policy the plaintext surface lacked).
--
-- A row exists only to RESTRICT: absence of a row means "no restriction" (all
-- tool categories allowed), so this table is a no-op until a policy is set.
-- `allowed_tool_categories` lists the coarse categories the agent may use in the
-- stream (e.g. {'web'} = web egress but nothing else, {} = no tools at all);
-- the 'messaging' reply tool is always allowed regardless. Values are validated
-- in code, not by a DB enum (INV-3). Policy rows are keyed by non-thread root
-- streams — threads inherit their root's policy, mirroring stream access.

CREATE TABLE IF NOT EXISTS stream_policies (
    stream_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    allowed_tool_categories TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Carry over any policy set on an E2E scratchpad (NULL there meant "no
-- restriction", which is now expressed by row absence).
INSERT INTO stream_policies (stream_id, workspace_id, allowed_tool_categories)
SELECT stream_id, workspace_id, allowed_tool_categories
FROM e2e_streams
WHERE allowed_tool_categories IS NOT NULL
ON CONFLICT (stream_id) DO NOTHING;

-- stream_policies is now the single source of truth for the policy.
ALTER TABLE e2e_streams
    DROP COLUMN IF EXISTS allowed_tool_categories;
