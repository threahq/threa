-- The docs the user has open in a pane on the reported device, so "the doc"
-- in a companion request resolves to the one in front of them.
ALTER TABLE user_device_contexts ADD COLUMN IF NOT EXISTS open_doc_ids TEXT[] NOT NULL DEFAULT '{}';
