-- Voice/video calls (M0 PR 0.2, review round) — per-endpoint connection sequence.
-- Append-only (INV-17), workspace-scoped rows unchanged (INV-8), no new table.
--
-- connection_seq is a monotonic fencing counter (INV-66) bumped on every (re)bind
-- of an endpoint. epoch alone cannot fence a socket disconnect against a fast
-- same-incarnation reconnect: a reload rebinds the endpoint back to `connected`
-- at the SAME epoch before the old socket's fire-and-forget demotion commits, so
-- the demotion's (epoch, status='connected') fence still matches and wedges the
-- live endpoint at `reconnecting`. rebind bumps connection_seq, and the disconnect
-- demotion is fenced on the seq the socket bound at, so a stale demotion no-ops.

ALTER TABLE call_endpoints
  ADD COLUMN IF NOT EXISTS connection_seq INTEGER NOT NULL DEFAULT 0;
