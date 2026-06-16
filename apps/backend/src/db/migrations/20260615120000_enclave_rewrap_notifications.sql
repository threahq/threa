-- Dedup ledger for proactive owner re-wrap nudges. When a user message enqueues
-- an enclave turn that no live EIK can serve — every running instance minted a
-- fresh key after a roll/restart and none holds this stream's SSK wrap — only
-- the owner's unlocked device can re-wrap (the enclave can't seal to itself,
-- INV-E7). The claim-poll sweep nudges the owner: a socket signal heals an
-- online unlocked tab in place, and a graced web-push pulls an offline owner
-- back to the app where the same heal fires.
--
-- This is workflow state, not domain state, so it lives off `enclave_invocations`
-- (INV-57). One row per (workspace, root stream) — the wraps and the heal are
-- the root's (a thread carries none of its own), so threads coalesce onto their
-- root. The two `*_emit_at` columns are the per-channel dedup clocks: the sweep
-- re-arms a channel only once its re-emit window has elapsed, so a churny fleet
-- (fresh EIK on every enclave start) can't spam the owner. Race-safe across
-- concurrent pollers via the upsert's conflict guard (INV-20).
--
-- Per INV-1 no foreign keys; per INV-8 every read/write filters by workspace_id.

CREATE TABLE IF NOT EXISTS enclave_rewrap_notifications (
  workspace_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  last_socket_emit_at TIMESTAMPTZ,
  last_webpush_emit_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, root_stream_id)
);
