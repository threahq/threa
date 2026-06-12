-- Add a declared-output manifest to bot runtime instances.
-- Populated from the optional `manifest` block on bot:hello; null means the
-- runtime declared none and is treated as the legacy default output profile
-- (reply + trace, no sources). The verb-boundary reject-undeclared check
-- (Phase 2.3b) reads it per claiming instance.

ALTER TABLE bot_runtime_instances
ADD COLUMN IF NOT EXISTS manifest JSONB;
