-- decided: the source messages commit to the memo. proposed: put forward, neither
-- adopted nor rejected where the messages end.
ALTER TABLE memos ADD COLUMN IF NOT EXISTS standing TEXT NOT NULL DEFAULT 'decided';
