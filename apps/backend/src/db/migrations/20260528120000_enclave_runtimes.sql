-- Registry of live enclave runtime instances. Each instance generates its own
-- X25519 Enclave Instance Key (EIK) at boot, registers it here, and refreshes
-- last_seen_at via a periodic heartbeat. The dispatcher selects from the
-- "live" set (revoked_at IS NULL AND last_seen_at > now() - interval '2 minutes')
-- per invocation; the per-stream symmetric key (SSK) is HPKE-wrapped to every
-- live EIK so whichever instance the dispatcher picks can decrypt the stream.
--
-- Global table (no workspace_id): falls under CLAUDE.md INV-8's auth/infra
-- exception. ID prefix `elr_` per INV-2. Multi-instance from day one — no
-- "single active key" constraint; uniqueness is on key_id only. Key rotation
-- is per-instance: a new process boot generates a fresh EIK and registers it;
-- the old row falls out of the live set on heartbeat staleness.

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

-- Partial index over the "live" set so the dispatcher's target pick and the
-- frontend's active-key fetch stay cheap as the table accumulates tombstones.
CREATE INDEX idx_enclave_runtimes_live
  ON enclave_runtimes (last_seen_at DESC)
  WHERE revoked_at IS NULL;
