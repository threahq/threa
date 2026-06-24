-- Add a target reference column for in-app memo link previews.
-- Populated only when content_type = 'memo_link'; NULL for every other preview.
-- No foreign keys per INV-1.

ALTER TABLE link_previews ADD COLUMN target_memo_id TEXT;
