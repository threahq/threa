-- =============================================================================
-- Conversations: secondary_message_ids array for multi-membership
-- =============================================================================
--
-- Adds a parallel array to `message_ids` for messages that ALSO belong to this
-- conversation but whose primary lives elsewhere. The boundary extractor uses
-- this for cross-topic references — a message can have one primary conversation
-- (in `message_ids`) and any number of secondary memberships (in
-- `secondary_message_ids` on other conversations).
--
-- Defaulting to '{}' is safe: existing conversations have no secondaries yet,
-- so the array is just empty. No backfill required.

ALTER TABLE conversations
    ADD COLUMN secondary_message_ids TEXT[] NOT NULL DEFAULT '{}';

-- GIN index so "which conversations contain this message as secondary?" stays
-- O(matches) instead of a full sequential scan. Mirrors the existing
-- idx_conversations_messages on `message_ids`.
CREATE INDEX idx_conversations_secondary_messages
    ON conversations USING GIN (secondary_message_ids);
