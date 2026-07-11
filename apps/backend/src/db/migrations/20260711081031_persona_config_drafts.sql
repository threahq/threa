-- Per-editor persona config drafts (roadmap 7.1 test-drive substrate). A draft
-- is the candidate patch an admin is editing before they commit it to
-- `agent_config_overrides`; the live test chat runs the draft, not the saved
-- override, so the admin talks to the candidate persona first. This is a
-- tracking table (INV-57): no draft state lives on the persona/override rows,
-- and the row is deleted on commit (in the override txn) or discard.
--
-- Scoped per `(workspace_id, agent_id, created_by)` — each admin holds their own
-- draft of a persona, so two admins editing Ariadne don't clobber each other.
-- `patch` is the same sparse editable-field shape stored in
-- `agent_config_overrides.patch` (validated in app code via the shared schema,
-- INV-3 no DB enums, INV-1 no FKs). `test_stream_id` binds the ephemeral test
-- scratchpad (a real `streams` row, archived on discard); nullable because a
-- draft can exist before the admin starts a test chat.
CREATE TABLE IF NOT EXISTS persona_config_drafts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    patch JSONB NOT NULL,
    test_stream_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, agent_id, created_by)
);

-- The companion dispatch path looks a draft up by the stream a message landed
-- in (is this a test stream, and whose draft?). Partial: only bound drafts are
-- reachable this way, and a stream binds to at most one draft.
CREATE INDEX IF NOT EXISTS idx_persona_config_drafts_test_stream
    ON persona_config_drafts (test_stream_id)
    WHERE test_stream_id IS NOT NULL;

-- Keep `updated_at` fresh on UPDATE (mirrors agent_config_overrides; the editor
-- shows "draft saved Ns ago" from this column).
CREATE OR REPLACE FUNCTION set_persona_config_drafts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_persona_config_drafts_set_updated_at ON persona_config_drafts;

CREATE TRIGGER trg_persona_config_drafts_set_updated_at
BEFORE UPDATE ON persona_config_drafts
FOR EACH ROW
EXECUTE FUNCTION set_persona_config_drafts_updated_at();
