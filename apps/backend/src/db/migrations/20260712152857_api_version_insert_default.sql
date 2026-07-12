-- Close the rolling-deploy window on api_version pinning: instances running
-- pre-column code INSERT without api_version, which lands NULL — and NULL now
-- means "deliberately unpinned, tracks the current version". A DEFAULT makes
-- those old-code mints epoch-pinned like every other pre-existing key; new
-- code always writes the pin explicitly, so the DEFAULT is only ever hit by
-- code that predates the column.
ALTER TABLE user_api_keys ALTER COLUMN api_version SET DEFAULT '2026-07-12';
ALTER TABLE bot_api_keys ALTER COLUMN api_version SET DEFAULT '2026-07-12';

-- Rows minted by old code between the first backfill and this statement (same
-- deploy). Deliberate unpins cannot exist yet: the detach feature ships with
-- the code this migration precedes.
UPDATE user_api_keys SET api_version = '2026-07-12' WHERE api_version IS NULL;
UPDATE bot_api_keys SET api_version = '2026-07-12' WHERE api_version IS NULL;
