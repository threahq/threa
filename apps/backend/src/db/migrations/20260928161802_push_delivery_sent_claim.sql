-- Pins sent_topic/sent_with_receipt to the claim that recorded them. A replica
-- that predates these columns claims, sends and settles without touching them,
-- so after it accepts a row the recorded values describe an earlier attempt.
-- An accepted row's accepting claim is always version - 1 (settle adds one), so
-- sent_claim_version = version - 1 proves the record is the accepting send's.
--
-- sent_at: database time the recording claim passed its last ownership check,
-- just before its network send; a lower bound on when that send began.
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS sent_claim_version INTEGER;
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
