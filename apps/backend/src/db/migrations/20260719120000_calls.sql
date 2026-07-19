-- Voice/video calls (M0 PR 0.1) — a call is a set of rows in call-scoped
-- tracking tables (INV-57) attached to an existing stream, never a new stream
-- type. Four tables split the concerns the review round found cannot share one
-- row: the ring ATTEMPT (call_invitations), the membership GRANT
-- (call_participants), and the admitted device SESSION whose liveness lease
-- lives here, persisted (call_endpoints). No state lives on the stream.
--
-- All statuses are TEXT constrained in application code (INV-3), never DB enums;
-- allowed values are in features/calls/config.ts. Prefixed ULID ids (INV-2),
-- workspace-scoped (INV-8), no foreign keys (INV-1), append-only (INV-17).
-- Every state transition is CAS-guarded on the prior status (INV-20); the
-- endpoint `epoch` is an integer fencing token (INV-66) so a stale instance
-- cannot resurrect a superseded endpoint.
--
-- Transcription tables (call_transcription_*, call_utterances) and the guest
-- column (is_guest) are DEFERRED to their own follow-ups and are deliberately
-- absent — the v1 schema is designed to compose with them, not to ship them.

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,                     -- call_
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,                 -- host stream (channel or dm)
  started_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | empty_grace | ended
  mode TEXT NOT NULL,                      -- video | audio_only (immutable v1)
  media_transport TEXT NOT NULL DEFAULT 'sfu', -- 'sfu' (v1); 'p2p' reserved for Later direct calls
  chat_stream_id TEXT,                     -- lazily created call-chat stream (later PR)
  sharing_endpoint_id TEXT,                -- server-owned screen-share claim (later PR)
  grace_deadline TIMESTAMPTZ,              -- set when status enters empty_grace
  ended_reason TEXT,                       -- completed | reaped
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active call per stream. Simultaneous mutual starts resolve to one row via
-- INSERT ... ON CONFLICT DO NOTHING against this partial index plus a
-- same-transaction re-read (INV-20).
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_active_per_stream
  ON calls (workspace_id, stream_id)
  WHERE status IN ('active', 'empty_grace');

-- The grace-end sweep scans empty_grace calls past their deadline. The three
-- sweep indexes (this one, ring-expiry, endpoint-lease-expiry) lead with the
-- time column, not workspace_id: the sweepers run global, workspace-agnostic
-- scans (an intentional cross-workspace infra scan, the same carve-out INV-8
-- grants queue/outbox internals), so a workspace-leading index would not serve
-- them. Partial-UNIQUE and lookup indexes still lead with workspace_id.
CREATE INDEX IF NOT EXISTS idx_calls_grace_deadline
  ON calls (grace_deadline)
  WHERE status = 'empty_grace';

CREATE TABLE IF NOT EXISTS call_invitations (
  id TEXT PRIMARY KEY,                     -- callinv_
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  invitee_user_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ringing',  -- ringing | accepted | declined | busy | expired | cancelled | superseded
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The ring-expiry sweep scans ringing invitations past their deadline.
CREATE INDEX IF NOT EXISTS idx_call_invitations_ring_expiry
  ON call_invitations (expires_at)
  WHERE status = 'ringing';

-- Per-call/per-invitee invitation lookup (accept-on-join, cancel).
CREATE INDEX IF NOT EXISTS idx_call_invitations_call_invitee
  ON call_invitations (workspace_id, call_id, invitee_user_id);

CREATE TABLE IF NOT EXISTS call_participants (
  id TEXT PRIMARY KEY,                     -- callp_
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'joined',   -- joined | left | removed
  invited_by TEXT,
  removed_by TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, call_id, user_id)
);

CREATE TABLE IF NOT EXISTS call_endpoints (
  id TEXT PRIMARY KEY,                     -- callep_
  workspace_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,                  -- fencing token (INV-66)
  status TEXT NOT NULL DEFAULT 'connected',-- connected | reconnecting | closed
  lease_expires_at TIMESTAMPTZ NOT NULL,   -- renewed at TTL/3 by the owning instance; swept by CAS
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live (admitted) endpoint per participant. A second device/tab is
-- rejected unless it takes over (which closes the prior endpoint first).
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_endpoints_live_per_participant
  ON call_endpoints (workspace_id, call_id, participant_id)
  WHERE status IN ('connected', 'reconnecting');

-- The lease-reap sweep scans live endpoints past their lease.
CREATE INDEX IF NOT EXISTS idx_call_endpoints_lease_expiry
  ON call_endpoints (lease_expires_at)
  WHERE status IN ('connected', 'reconnecting');
