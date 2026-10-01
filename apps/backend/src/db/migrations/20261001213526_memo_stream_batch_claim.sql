-- One memo batch per stream at a time. A batch claims the stream before it
-- reads pending items and saves only while it still holds the claim, so a
-- duplicate job dispatched during a long batch can't run the same items again.
ALTER TABLE memo_stream_state
ADD COLUMN IF NOT EXISTS batch_claim_token TEXT,
ADD COLUMN IF NOT EXISTS batch_claim_expires_at TIMESTAMPTZ;
