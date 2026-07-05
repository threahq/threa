-- Rolling content summary on conversations.
--
-- topic_summary is a 2-5 word title; it cannot tell the boundary extractor
-- (or the board card) what a conversation actually covers. summary is a short
-- prose description maintained by the boundary extractor itself on every pass
-- that touches the conversation — no separate summarizer flow.

ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS summary TEXT;
