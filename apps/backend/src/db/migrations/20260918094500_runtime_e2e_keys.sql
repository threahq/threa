-- Scoped E2E key registry for bot runtimes.
--
-- Supersedes the single `public_key` / `public_key_id` pair on
-- bot_runtime_instances, which held exactly one key per instance. A runtime now
-- carries a keyring and advertises every key it holds: each distinct key is one
-- row here, and a holder row records which instance currently offers it. Two
-- runtimes that loaded the same key file share one key row, so one stream wrap
-- serves both.
--
-- `stream_id` is the only scope the server enforces. A non-null value pins the
-- key to that one sealed root stream, so a leaked per-stream key opens one
-- stream; NULL means eligible for every stream the bot is invited to, which is
-- what the old single key was.
--
-- The public key stays opaque base64 TEXT, as on the presence row it replaces.

CREATE TABLE runtime_e2e_keys (
  workspace_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  stream_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- `key_id` is the wrap address (`stream_e2e_key_wraps.recipient_key_id`), so
  -- it must resolve to exactly one key per workspace. The client mints it, so
  -- there is no surrogate id to mint here.
  PRIMARY KEY (workspace_id, key_id)
);

CREATE TABLE runtime_e2e_key_holders (
  workspace_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, bot_id, instance_id, key_id)
);

-- "Which keys does this bot hold", the invite-time wrap-recipient read. The
-- claim gate goes the other way, from one instance to its keys, which the
-- primary key's leading columns already serve.
CREATE INDEX idx_runtime_e2e_key_holders_bot ON runtime_e2e_key_holders (workspace_id, bot_id);

-- Every instance that registered a BIK becomes an unscoped key under its
-- existing key id, so the wraps already addressed to it keep resolving the
-- moment the readers switch over. DISTINCT ON picks the freshest row per key id
-- because nothing stopped two instances from reporting the same id.
INSERT INTO runtime_e2e_keys (workspace_id, key_id, public_key)
SELECT DISTINCT ON (workspace_id, public_key_id) workspace_id, public_key_id, public_key
FROM bot_runtime_instances
WHERE public_key IS NOT NULL AND public_key_id IS NOT NULL
ORDER BY workspace_id, public_key_id, last_seen_at DESC;

INSERT INTO runtime_e2e_key_holders (workspace_id, key_id, bot_id, instance_id)
SELECT workspace_id, public_key_id, bot_id, instance_id
FROM bot_runtime_instances
WHERE public_key IS NOT NULL AND public_key_id IS NOT NULL
ON CONFLICT DO NOTHING;
