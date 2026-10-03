-- Batches in which a pending memo item failed classification, memorizing or
-- embedding. A failed item stays pending so the next batch retries it, and is
-- marked processed once this reaches the service's cap. A requeue resets it.
ALTER TABLE memo_pending_items
ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
