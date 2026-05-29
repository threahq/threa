-- Pin each invited E2E actor to a concrete identity.
--
-- Before this, e2e_stream_actors was keyed by (workspace_id, stream_id, kind),
-- so a scratchpad could hold at most one bot, and "which bot" was inferred from
-- whoever was the current active actor — meaning the underlying bot could be
-- swapped as long as some key was wrapped to it. Pinning `actor_id` makes the
-- bot a named principal the owner chose: its BIK / API key may rotate freely
-- under that id, but the wrap target is the bot_id, not a guess. Enclave rows
-- carry the sentinel actor_id 'enclave' (one first-party Ariadne).
--
-- New PK (workspace_id, stream_id, kind, actor_id) also lets a scratchpad hold
-- multiple bots at once. Additive + idempotent (INV-17).

ALTER TABLE e2e_stream_actors
  ADD COLUMN IF NOT EXISTS actor_id TEXT;

-- Backfill legacy rows: identity == kind preserves the old "one row per kind"
-- shape (the enclave sentinel; any pre-existing bot row had no concrete id to
-- recover, so it keeps the placeholder until the owner re-invites a real bot).
UPDATE e2e_stream_actors
  SET actor_id = kind
  WHERE actor_id IS NULL;

ALTER TABLE e2e_stream_actors
  DROP CONSTRAINT IF EXISTS e2e_stream_actors_pkey;

-- Adding the PK sets actor_id NOT NULL implicitly; the backfill above
-- guarantees no nulls remain.
ALTER TABLE e2e_stream_actors
  ADD PRIMARY KEY (workspace_id, stream_id, kind, actor_id);
