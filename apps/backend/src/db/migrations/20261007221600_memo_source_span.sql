-- When a memo's source messages were posted: the span of their created_at.
-- Nullable: a memo whose sources do not resolve has no span, and rows written
-- before this migration are filled by the memo-source-span backfill.
ALTER TABLE memos
  ADD COLUMN earliest_source_at TIMESTAMPTZ,
  ADD COLUMN latest_source_at TIMESTAMPTZ;
