-- The streams an agent-authored memo's content came from, raw ids (a thread stays a thread so its
-- own root resolves at read time). NULL for pipeline and user memos, whose source message or
-- conversation already locates them, and for agent memos written before this column existed.
ALTER TABLE memos ADD COLUMN source_stream_ids TEXT[];
