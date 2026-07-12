-- Public API header versioning (Phase 1): pin each API key to the dated wire
-- version it was minted against. The resolved version is header-overridable per
-- request, but the pin is the floor when no `Threa-Version` header is sent.
--
-- `TEXT`, validated in code against API_VERSIONS (INV-3 no DB enums). Existing
-- keys already speak today's shapes, which ARE the epoch version, so backfill
-- every pre-existing row to the epoch. New rows are written CURRENT_API_VERSION
-- by the key services. Workspace-scoped tables (INV-8); no FKs (INV-1).
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS api_version TEXT;
ALTER TABLE bot_api_keys ADD COLUMN IF NOT EXISTS api_version TEXT;

UPDATE user_api_keys SET api_version = '2026-07-12' WHERE api_version IS NULL;
UPDATE bot_api_keys SET api_version = '2026-07-12' WHERE api_version IS NULL;
