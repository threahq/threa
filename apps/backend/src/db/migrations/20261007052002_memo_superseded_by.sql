-- Each retired memo points at the memo that replaced it. parent_memo_id on the
-- replacement can name only one of the memos a capture retires, and none when
-- the correction deduped into an existing memo.
ALTER TABLE memos ADD COLUMN IF NOT EXISTS superseded_by_memo_id TEXT;

UPDATE memos AS retired
SET superseded_by_memo_id = successor.id
FROM memos AS successor
WHERE successor.workspace_id = retired.workspace_id
  AND successor.parent_memo_id = retired.id
  AND retired.status = 'superseded'
  AND retired.superseded_by_memo_id IS NULL;
