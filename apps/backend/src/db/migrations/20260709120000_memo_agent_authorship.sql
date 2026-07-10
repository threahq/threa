-- Agent-authored memos (roadmap 6.2, the `save_memo` tool).
--
-- `authored_by_kind` records who created the memo: 'pipeline' (the passive GAM
-- extractor over settled conversations — the default for every existing row) or
-- 'agent' (an explicit persona write). It is NOT a new `memo_type` value: the
-- `memo_type_source` CHECK ties memo_type ∈ {message, conversation} to a source
-- id, so 'agent' there would violate it. A `save_memo` write keeps memo_type
-- 'message' (anchored to its source messages) and sets authored_by_kind 'agent'.
--
-- `source_session_id` carries provenance (the agent session that wrote it),
-- nullable — pipeline memos have no session. Reflective session-sourced captures
-- that lack a message/conversation source (roadmap 6.3) will extend the
-- memo_type_source CHECK in their own migration; 6.2 requires a message source.

ALTER TABLE memos
ADD COLUMN IF NOT EXISTS authored_by_kind TEXT NOT NULL DEFAULT 'pipeline';

ALTER TABLE memos
ADD COLUMN IF NOT EXISTS source_session_id TEXT;
