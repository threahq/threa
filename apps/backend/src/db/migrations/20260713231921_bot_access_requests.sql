-- Bot access requests (F3) — a bot runtime that receives the workspace-wide
-- `delegation:available` nudge but lacks stream access files a request instead
-- of silently 404ing on claim. A card renders in the target stream; a stream
-- MEMBER approves (granting the bot standing access + re-nudging the runner) or
-- denies. This is a tracking table (INV-57): no state lives on messages — the
-- timeline card renders from the `bot_access:requested` event, patched by
-- `bot_access:status_changed`.
--
-- bot_name / delegation_title are SNAPSHOTS: a non-member approver cannot
-- resolve an ungranted personal bot from their roster (bot visibility is
-- grant-based), so the card must not depend on the roster. delegation_id/title
-- are duplicated onto the status event so the broadcast-handler re-nudge branch
-- needs no DB read.
--
-- Status is TEXT constrained in application code by BOT_ACCESS_REQUEST_STATUSES
-- ('open' | 'approved' | 'denied'), per INV-3. Approve/deny CAS on status='open'
-- (INV-20) — exactly one resolver wins. resolved_by is the approving/denying
-- user (application-enforced reference, INV-1 no FKs). Per INV-8 every read/write
-- filters by workspace_id.
CREATE TABLE IF NOT EXISTS bot_access_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  delegation_id TEXT,
  bot_name TEXT NOT NULL,
  delegation_title TEXT,
  requested_by_label TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One OPEN request per (bot, stream): a re-request while one is open resolves to
-- the existing row (ON CONFLICT), so a bot polling the nudge never spawns
-- duplicate cards. Partial so approved/denied rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_access_requests_one_open
  ON bot_access_requests (workspace_id, bot_id, stream_id)
  WHERE status = 'open';

-- Per-stream listing of pending requests (the member-facing "awaiting approval"
-- read); the partial predicate keeps the index to the open set.
CREATE INDEX IF NOT EXISTS idx_bot_access_requests_open
  ON bot_access_requests (workspace_id, stream_id, created_at)
  WHERE status = 'open';
