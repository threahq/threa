-- What the latest attempt that passed its pre-send ownership check actually
-- sent, so receipt monitoring can reason about provider topic collapse and
-- about whether the accepted send carried a receipt capability, without
-- reconstructing either from current source rows.
--
-- sent_with_receipt: NULL = never recorded (no attempt reached the send, or a
-- replica that predates this column sent it). Non-NULL marks the row as
-- recorded, so sent_topic NULL alongside it means the push had no topic.
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS sent_topic TEXT;
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS sent_with_receipt BOOLEAN;

-- Same-registration lookup for the monitor's collapse check.
CREATE INDEX IF NOT EXISTS idx_push_deliveries_subscription
  ON push_deliveries (subscription_id, subscription_generation);

-- Matured automatic receipt cohorts are selected by capability expiry.
CREATE INDEX IF NOT EXISTS idx_push_receipts_delivery_capability_expiry
  ON push_receipts (capability_expires_at) WHERE scope = 'delivery';
