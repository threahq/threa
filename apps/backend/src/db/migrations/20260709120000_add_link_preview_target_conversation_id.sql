-- Add a target reference column for in-app conversation link previews.
-- Populated only when content_type = 'conversation_link'; NULL for every other preview.
-- No foreign keys per INV-1.

ALTER TABLE link_previews ADD COLUMN target_conversation_id TEXT;
