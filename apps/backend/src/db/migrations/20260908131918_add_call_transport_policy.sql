ALTER TABLE call_transport_transfers
  DROP CONSTRAINT IF EXISTS call_transport_transfers_cause_check;
ALTER TABLE call_transport_transfers
  ADD CONSTRAINT call_transport_transfers_cause_check
  CHECK (cause IN ('explicit', 'automatic_threshold', 'rollout_safety'));
ALTER TABLE call_transport_transfers
  ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE call_transport_transfers
  ADD COLUMN IF NOT EXISTS actor_type TEXT
    CHECK (actor_type IN ('human', 'system')),
  ADD COLUMN IF NOT EXISTS actor_endpoint_id TEXT;

CREATE TABLE IF NOT EXISTS call_transport_policy_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  admitted_count INTEGER NOT NULL CHECK (admitted_count >= 0 AND admitted_count <= 50),
  desired_transport TEXT NOT NULL CHECK (desired_transport IN ('sfu', 'p2p')),
  eligibility_deadline TIMESTAMPTZ,
  eligibility_generation INTEGER NOT NULL DEFAULT 0 CHECK (eligibility_generation >= 0),
  source_transport_generation INTEGER NOT NULL CHECK (source_transport_generation > 0),
  explicit_hold_target TEXT CHECK (explicit_hold_target IN ('sfu', 'p2p')),
  explicit_hold_admitted_count INTEGER CHECK (explicit_hold_admitted_count >= 0 AND explicit_hold_admitted_count <= 50),
  latest_reason TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, call_id),
  CHECK ((eligibility_deadline IS NULL) = (eligibility_generation = 0)),
  CHECK ((explicit_hold_target IS NULL) = (explicit_hold_admitted_count IS NULL))
);

CREATE INDEX IF NOT EXISTS call_transport_policy_states_deadline
  ON call_transport_policy_states (eligibility_deadline)
  WHERE eligibility_deadline IS NOT NULL;
