CREATE TABLE dynamic_naming_state (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  last_evaluated_message_count INTEGER NOT NULL DEFAULT 0 CHECK (last_evaluated_message_count >= 0),
  consecutive_keeps INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_keeps >= 0),
  completed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  structure_version INTEGER NOT NULL DEFAULT 0 CHECK (structure_version >= 0),
  last_evaluated_structure_version INTEGER NOT NULL DEFAULT 0 CHECK (last_evaluated_structure_version >= 0),
  last_structural_event_id BIGINT,
  regeneration_pending BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token VARCHAR(80),
  claim_owner_id VARCHAR(160),
  claim_checkpoint INTEGER,
  claim_message_count INTEGER,
  claim_structure_version INTEGER,
  claim_title_revision INTEGER,
  claim_reason TEXT,
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, target_kind, target_id),
  CHECK (last_evaluated_structure_version <= structure_version),
  CHECK (claim_checkpoint IS NULL OR claim_checkpoint IN (1, 3, 6, 10)),
  CHECK (claim_message_count IS NULL OR claim_message_count >= 0),
  CHECK (claim_structure_version IS NULL OR claim_structure_version >= 0),
  CHECK (claim_title_revision IS NULL OR claim_title_revision >= 0),
  CHECK (claim_reason IS NULL OR claim_reason IN ('ordinary', 'structural', 'regenerate')),
  CHECK ((claim_token IS NULL) = (claim_owner_id IS NULL)),
  CHECK ((claim_token IS NULL) = (claim_title_revision IS NULL)),
  CHECK ((claim_token IS NULL) = (claim_reason IS NULL)),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL))
);

CREATE INDEX dynamic_naming_state_expired_claim_idx
  ON dynamic_naming_state (workspace_id, claim_expires_at, target_kind, target_id)
  WHERE claim_token IS NOT NULL;
