-- Add `card_version` to memos so memo-embed card patches order absolutely.
-- The client's newer-wins guard (a raced message:edited payload vs a
-- memo:updated patch) compared millisecond `updatedAt` values, which tie when
-- two memo edits land inside one millisecond — an integer bumped on every
-- card-field update has no tie (INV-66, same shape as
-- scheduled_messages.version).
--
-- NOT the existing `version` column: that one is the supersession REVISION
-- number (chains order on it via ORDER BY version DESC), so bumping it on a
-- title edit would let an edited old revision outrank the capture that
-- superseded it. Card ordering gets its own counter.
--
-- Only MemoRepository.update (the sole path that changes card fields — title,
-- knowledge_type, tags) increments it. Embedding refreshes, supersession and
-- archive status flips bump `updated_at` but not the card version: the card
-- renders none of those.

ALTER TABLE memos
  ADD COLUMN IF NOT EXISTS card_version INTEGER NOT NULL DEFAULT 1;
