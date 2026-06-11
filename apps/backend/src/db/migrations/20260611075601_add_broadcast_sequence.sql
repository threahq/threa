-- Dense per-stream ordering over viewer-visible timeline events (INV-61).
--
-- The global `sequence` counter is shared by ALL event types, including
-- author-scoped command events and patch-style rows (edits, reactions) that
-- are never delivered to other viewers as timeline rows — so a viewer's
-- persisted sequence set has legitimate, unfillable holes and clients cannot
-- distinguish "missed message" from "someone else's /command". The
-- `broadcast_sequence` counter increments only for TIMELINE_BROADCAST_EVENT_TYPES
-- (events every member receives as appended rows), making the chain dense for
-- every viewer: a missing broadcast_sequence is always a real gap that a
-- backfill fetch can close.

ALTER TABLE stream_events
ADD COLUMN IF NOT EXISTS broadcast_sequence BIGINT;

ALTER TABLE stream_sequences
ADD COLUMN IF NOT EXISTS next_broadcast_sequence BIGINT NOT NULL DEFAULT 1;

-- Backfill: number existing broadcast-type rows densely per stream in
-- `sequence` order. Rows that vanished from a stream before this migration
-- (the message-move flow reassigns rows to the destination thread) simply
-- don't participate, so the historical numbering is dense over what remains.
UPDATE stream_events e
SET broadcast_sequence = numbered.rn
FROM (
    SELECT id, row_number() OVER (PARTITION BY stream_id ORDER BY sequence) AS rn
    FROM stream_events
    WHERE event_type IN (
        'message_created',
        'member_joined',
        'member_added',
        'member_left',
        'agent_session:started',
        'agent_session:completed',
        'agent_session:failed',
        'agent_session:deleted',
        'messages:moved'
    )
) numbered
WHERE e.id = numbered.id
  AND e.broadcast_sequence IS NULL;

-- Seed each stream's counter just past its highest assigned slot. Streams
-- with no broadcast events keep the column default of 1.
UPDATE stream_sequences ss
SET next_broadcast_sequence = GREATEST(
    ss.next_broadcast_sequence,
    COALESCE(
        (SELECT MAX(e.broadcast_sequence) + 1 FROM stream_events e WHERE e.stream_id = ss.stream_id),
        1
    )
);

-- Density is a correctness invariant — enforce uniqueness at the source.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_events_stream_broadcast_seq
    ON stream_events (stream_id, broadcast_sequence)
    WHERE broadcast_sequence IS NOT NULL;
