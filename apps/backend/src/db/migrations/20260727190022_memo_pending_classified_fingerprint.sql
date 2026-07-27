-- Remember what the memo classifier was last shown for a conversation, so a
-- re-queue that carries no new content can skip the AI call.
--
-- Boundary extraction emits `conversation:updated` for completeness and summary
-- changes, not only for new messages, and the accumulator queues on every one.
-- In production that produced 37 of 602 classify calls where the conversation
-- had not changed at all since the previous pass.
--
-- NULL means "never classified" and always classifies — existing rows keep
-- their current behaviour rather than being assumed unchanged.

ALTER TABLE memo_pending_items
ADD COLUMN IF NOT EXISTS classified_fingerprint TEXT;
