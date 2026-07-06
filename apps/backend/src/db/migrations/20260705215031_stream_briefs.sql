-- Stream briefs (roadmap 4.1) — a durable, versioned, human-auditable working
-- document per stream, injected into every companion turn. Unlike the rolling
-- conversation summary (ephemeral, rebuilt per turn), the brief is explicit
-- shared state: users edit it via API/UI, the agent maintains it via a tool
-- (4.2). Content is a prompt insert, not a document store — the service caps it
-- at ~4k chars.
--
-- version is the optimistic-concurrency token (INV-20): every write must carry
-- the version it read, and the update guards WHERE version = expected, so a
-- concurrent human edit and agent write can't silently clobber each other.
--
-- stream_brief_revisions is the append-only audit trail: one row per accepted
-- write (including the create), so "who changed the brief and when" is always
-- answerable and a bad edit can be recovered by hand.
--
-- Per INV-1 no foreign keys; per INV-3 updated_by_kind is TEXT constrained in
-- application code by the BriefAuthorKind union ('user' | 'persona'); per
-- INV-8 every read/write filters by workspace_id. Threads carry no brief of their own — they inherit the root
-- stream's brief at prompt-assembly time, mirroring the access rule (INV-62).

CREATE TABLE IF NOT EXISTS stream_briefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  content TEXT NOT NULL,
  version INT NOT NULL,
  updated_by_kind TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One brief per stream; also the lookup path for both the endpoints and the
-- per-turn prompt injection.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_briefs_stream
  ON stream_briefs (stream_id);

CREATE TABLE IF NOT EXISTS stream_brief_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  version INT NOT NULL,
  content TEXT NOT NULL,
  updated_by_kind TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit-trail listing: revisions of a brief, newest first.
CREATE INDEX IF NOT EXISTS idx_stream_brief_revisions_brief
  ON stream_brief_revisions (brief_id, version DESC);
