-- Newest message activity (post or edit time) the last memo pass over this item
-- read. A conversation too long for one pass reads what came after it.
-- Null = never read.
ALTER TABLE memo_pending_items
ADD COLUMN IF NOT EXISTS read_through TIMESTAMPTZ;
