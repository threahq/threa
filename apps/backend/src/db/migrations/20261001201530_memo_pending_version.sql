-- Bumped every time a pending memo item is queued, including while it is
-- already pending. A batch acknowledges an item only at the version it read, so
-- a conversation that changed during the batch's model calls stays pending.
ALTER TABLE memo_pending_items
ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
