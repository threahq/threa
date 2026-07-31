-- Compose-session provenance sidecar: what the author could have seen when they
-- started writing, and how far the stream had moved by the time they sent.
-- Analytical signal, not message state, so it lives beside `messages` rather
-- than on it (INV-57). New data only — no backfill is possible for sends that
-- predate client capture.
CREATE TABLE message_compose_traces (
  message_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- Destination: the stream the message landed in.
  stream_id TEXT NOT NULL,
  -- Horizon: the stream the two sequences were measured against (the surface the
  -- author was reading). Sequences are per-stream and a send can route elsewhere,
  -- so this is the only id the numbering is interpretable against.
  horizon_stream_id TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  opened_at_sequence BIGINT,
  sent_at_sequence BIGINT,
  resumed_draft BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_message_compose_traces_workspace_stream
  ON message_compose_traces (workspace_id, stream_id, created_at DESC);
