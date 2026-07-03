-- Persist superseded write ids on draft tombstones.
--
-- Resolve-on-send (and explicit discard) can race the author's own in-flight
-- upsert: a push that left the device before the send but reaches the server
-- after the tombstone. Until now the superseded write ids were only checked at
-- resolve time, so that late write hit "tombstoned + version drift" and SPLIT
-- into a live duplicate of already-sent content — a zombie draft on every
-- device. Storing the ids on the tombstone lets the upsert path recognize the
-- late write as superseded and drop it instead.

ALTER TABLE drafts
ADD COLUMN IF NOT EXISTS superseded_write_ids JSONB;
