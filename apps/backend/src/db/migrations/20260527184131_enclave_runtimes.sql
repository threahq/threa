-- Registry of live enclave runtime instances. Each instance generates its own
-- X25519 Enclave Instance Key (EIK) at boot, registers it here, and refreshes
-- last_seen_at via a periodic heartbeat. The dispatcher selects from the
-- "live" set (revoked_at IS NULL AND last_seen_at > now() - interval '2 minutes')
-- per invocation, and the frontend includes every live EIK as an additional
-- recipient when encrypting a message to an enclave-invited E2E stream.
--
-- Global table (no workspace_id): falls under CLAUDE.md INV-8's auth/infra
-- exception. ID prefix `elr_` per INV-2. Multi-instance from day one — no
-- "single active key" constraint; uniqueness is on key_id only. Key rotation
-- is per-instance: an instance marks its own prior row revoked_at = NOW() and
-- inserts a new row in the same transaction (no cross-instance interference).

CREATE TABLE enclave_runtimes (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  instance_url TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_enclave_runtimes_key_id
  ON enclave_runtimes (key_id);

-- Partial index over the "live" set so dispatcher queries (active EIKs for
-- the current frontend recipient list, dispatcher target pick) stay cheap as
-- the table accumulates tombstones.
CREATE INDEX idx_enclave_runtimes_live
  ON enclave_runtimes (last_seen_at DESC)
  WHERE revoked_at IS NULL;
