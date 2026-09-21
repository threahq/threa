-- Incoming webhooks: a secret URL bound to one bot and one stream.

CREATE TABLE incoming_webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_incoming_webhooks_bot ON incoming_webhooks (workspace_id, bot_id);
