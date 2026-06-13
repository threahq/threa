-- Centralized drafts — one first-class entity per composer payload, owned by a
-- user and scoped to a stream or a not-yet-threaded parent message. Drafts live
-- in IndexedDB first and mirror here so they roam across the author's devices.
--
-- Concurrency is optimistic on `version` (integer CAS in the WHERE clause, the
-- same primitive scheduled_messages uses). On a version mismatch the service
-- SPLITS — it leaves the existing row untouched and inserts a NEW draft from
-- the incoming content — rather than overwriting. Duplicated drafts are
-- acceptable; lost drafts are not.
--
-- `last_client_write_id` is the per-push idempotency key. A lost ack makes the
-- client retry the same upsert; matching this column short-circuits to the
-- existing row so the retry doesn't read as drift and spuriously split.
--
-- Content is one of two shapes. Plaintext streams carry content_json /
-- content_markdown; E2E streams carry ciphertext / envelope / e2e_version with
-- the plaintext columns null (the draft is sealed to the stream key before it
-- ever leaves the device, honoring E2EE-4 "no plaintext at rest").
--
-- Per INV-1 no foreign keys; per INV-3 scope is TEXT validated in application
-- code; per INV-8 / INV-50 every read/write filters by (workspace_id, user_id)
-- and drafts are private to their author. Soft delete (deleted_at) is the
-- cross-device tombstone for resolve-on-send and explicit discard.

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  root_stream_id TEXT,
  content_json JSONB,
  content_markdown TEXT,
  attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  command JSONB,
  context_refs JSONB,
  ciphertext TEXT,
  envelope JSONB,
  e2e_version INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  last_client_write_id TEXT,
  client_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Bootstrap list for a user (every live draft, newest first). The trailing
-- `id DESC` matches `listByUser`'s tiebreak so the index fully covers the sort
-- when two drafts share a `client_updated_at`.
CREATE INDEX IF NOT EXISTS idx_drafts_user_recency
  ON drafts (workspace_id, user_id, client_updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Per-scope lookup (the loaded draft plus its stash siblings).
CREATE INDEX IF NOT EXISTS idx_drafts_user_scope
  ON drafts (workspace_id, user_id, scope)
  WHERE deleted_at IS NULL;
