-- Sparse read overlay: individually-read messages ABOVE a member's watermark.
-- A message is effectively read iff sequence <= watermark OR id in this overlay.
-- See docs/sparse-read-overlay-design.md. No FKs (INV-1); workspace-scoped (INV-8);
-- member_id is the stream-membership identity surface (INV-50). event_id/sequence
-- are denormalized at write (stream_events keys messages inside payload->>'messageId')
-- and refreshed only by a message move.

CREATE TABLE IF NOT EXISTS stream_member_message_reads (
  workspace_id TEXT NOT NULL,
  stream_id    TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  sequence     BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_id, member_id, message_id)
);

-- Compaction window scan + prune-at/above-watermark run over (stream, member)
-- ordered by sequence; the PK prefix (stream_id, member_id) is not sorted on
-- sequence, so give those range deletes/scans a sorted path.
CREATE INDEX IF NOT EXISTS idx_smmr_stream_member_sequence
  ON stream_member_message_reads (stream_id, member_id, sequence);

-- Move rehome rewrites every member's overlay row for the moved message ids by
-- (stream_id, message_id); the PK can't serve that (message_id isn't a prefix).
CREATE INDEX IF NOT EXISTS idx_smmr_stream_message
  ON stream_member_message_reads (stream_id, message_id);
