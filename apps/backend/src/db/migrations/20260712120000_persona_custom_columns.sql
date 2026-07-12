-- Custom (workspace) personas (roadmap 7.1 step 2). The write layer lands here:
-- a workspace can fork a built-in or another custom into an editable `personas`
-- row. Four columns the read-only seed never needed now become real per-row
-- config:
--   escalation_model  -- stronger per-turn escalation model (was built-in only)
--   avatar_url        -- base path of an uploaded avatar image (populated step 3)
--   tone_prompt       -- free-text style slot (materialized from a source preset
--   brevity_prompt    --   on fork, or authored directly); built-ins use presets
-- All nullable and additive (INV-17 append-only). System personas keep NULLs.
ALTER TABLE personas
    ADD COLUMN IF NOT EXISTS escalation_model TEXT,
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS tone_prompt TEXT,
    ADD COLUMN IF NOT EXISTS brevity_prompt TEXT;

-- Keep `updated_at` fresh on UPDATE so it can serve as the optimistic-concurrency
-- token for custom-persona edits (mirrors agent_config_overrides /
-- persona_config_drafts, which maintain this column via the same trigger shape).
-- BEFORE UPDATE only — the seed INSERT and forks set it from DEFAULT NOW().
CREATE OR REPLACE FUNCTION set_personas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_personas_set_updated_at ON personas;

CREATE TRIGGER trg_personas_set_updated_at
BEFORE UPDATE ON personas
FOR EACH ROW
EXECUTE FUNCTION set_personas_updated_at();
