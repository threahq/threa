ALTER TABLE call_endpoints
  ADD COLUMN IF NOT EXISTS transfer_capability TEXT;

CREATE TABLE IF NOT EXISTS call_transport_transfers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_transport TEXT NOT NULL CHECK (source_transport IN ('sfu', 'p2p')),
  target_generation INTEGER NOT NULL CHECK (target_generation > 0),
  target_transport TEXT NOT NULL CHECK (target_transport IN ('sfu', 'p2p')),
  membership_revision INTEGER NOT NULL CHECK (membership_revision >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('preparing', 'committing', 'draining', 'aborting', 'failed', 'completed')),
  cause TEXT NOT NULL CHECK (cause = 'explicit'),
  idempotency_key TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prepare_deadline TIMESTAMPTZ,
  recovery_deadline TIMESTAMPTZ,
  failure_code TEXT,
  recovery_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, call_id, generation),
  UNIQUE (workspace_id, call_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS call_transport_transfers_one_unsettled
  ON call_transport_transfers (workspace_id, call_id)
  WHERE phase IN ('preparing', 'committing', 'draining', 'aborting');

CREATE INDEX IF NOT EXISTS call_transport_transfers_sweep
  ON call_transport_transfers (phase, prepare_deadline, recovery_deadline);

CREATE TABLE IF NOT EXISTS call_transport_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  endpoint_epoch INTEGER NOT NULL CHECK (endpoint_epoch >= 0),
  media_incarnation TEXT NOT NULL,
  transport_generation INTEGER NOT NULL CHECK (transport_generation > 0),
  media_transport TEXT NOT NULL CHECK (media_transport IN ('sfu', 'p2p')),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'active', 'draining', 'closed', 'failed')),
  provider_session_id TEXT,
  publication_revision INTEGER NOT NULL DEFAULT 0 CHECK (publication_revision >= 0),
  published_tracks JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, call_id, endpoint_id, media_incarnation, transport_generation)
);

CREATE INDEX IF NOT EXISTS call_transport_sessions_generation
  ON call_transport_sessions (workspace_id, call_id, transport_generation, status);
CREATE UNIQUE INDEX IF NOT EXISTS call_transport_sessions_live_incarnation
  ON call_transport_sessions (workspace_id, call_id, endpoint_id, transport_generation)
  WHERE status IN ('preparing', 'ready', 'active', 'draining');

CREATE TABLE IF NOT EXISTS call_transfer_obligations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  endpoint_epoch INTEGER NOT NULL CHECK (endpoint_epoch >= 0),
  media_incarnation TEXT NOT NULL,
  membership_revision INTEGER NOT NULL CHECK (membership_revision >= 0),
  track_revision INTEGER NOT NULL CHECK (track_revision >= 0),
  expected_publications JSONB NOT NULL DEFAULT '[]'::jsonb,
  ready_publications JSONB NOT NULL DEFAULT '[]'::jsonb,
  own_publications_ready BOOLEAN NOT NULL DEFAULT FALSE,
  switched BOOLEAN NOT NULL DEFAULT FALSE,
  switched_at TIMESTAMPTZ,
  source_released BOOLEAN NOT NULL DEFAULT FALSE,
  source_released_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, transfer_id, endpoint_id, media_incarnation)
);

CREATE INDEX IF NOT EXISTS call_transfer_obligations_barrier
  ON call_transfer_obligations (workspace_id, transfer_id, membership_revision, switched);
