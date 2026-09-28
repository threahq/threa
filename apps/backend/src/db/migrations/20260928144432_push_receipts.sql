-- Device receipts for push: first-party workflow state (INV-57), separate from
-- push_deliveries so a receipt never moves that row's claim/lease version.
--
-- receipt_version: the receipt protocol the registration's ACTIVE service
-- worker advertised at its last subscribe handshake. NULL = unknown (old
-- frontend, old worker, or a replica that predates this column): no receipt
-- capability is issued to it. Deliberately outside the generation trigger's
-- binding columns, so a worker upgrade never supersedes planned deliveries.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS receipt_version INTEGER;

-- One row per automatic device delivery (scope 'delivery', delivery_id set) or
-- per device of an explicit Send test (scope 'test', test_id set). Only the
-- SHA-256 of the capability token is stored. stream_id is a reference kept so
-- ingest can recheck the stream's current root E2E policy.
CREATE TABLE IF NOT EXISTS push_receipts (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  delivery_id           TEXT,
  test_id               TEXT,
  subscription_id       TEXT NOT NULL,
  device_key            TEXT,
  user_agent            TEXT,
  stream_id             TEXT,
  token_hash            TEXT,
  capability_expires_at TIMESTAMPTZ,
  provider_outcome      TEXT,
  provider_status_code  INTEGER,
  received_at           TIMESTAMPTZ,
  outcome               TEXT,
  outcome_reason        TEXT,
  outcome_at            TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  retain_until          TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_receipts_token_hash
  ON push_receipts (token_hash) WHERE token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_receipts_delivery
  ON push_receipts (workspace_id, delivery_id) WHERE delivery_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_receipts_test_device
  ON push_receipts (workspace_id, test_id, subscription_id) WHERE test_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_push_receipts_retain_until
  ON push_receipts (retain_until);
