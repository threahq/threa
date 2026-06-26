-- A message can declare which conversation it belongs to, instead of leaving
-- the async boundary-extractor to infer it. `conversation_intent` records that
-- declaration so the extractor skips (and never re-clusters) a human-declared
-- message:
--   NULL       → inferred: the extractor clusters it (default, unchanged).
--   'new'      → the send minted a fresh conversation seeded with this message.
--   'existing' → the send attached this message to a caller-named conversation.
-- The conversation membership itself lives on `conversations.message_ids`; this
-- column is the provenance/lock signal, not a second copy of the id.
ALTER TABLE messages DROP COLUMN IF EXISTS is_authored_boundary;
ALTER TABLE messages ADD COLUMN conversation_intent TEXT;
