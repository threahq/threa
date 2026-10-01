-- The provider replaces a pending push by endpoint and topic, and one endpoint
-- can back several subscription rows (two accounts in one browser, or an
-- opt-out and re-enable that inserts a new id), so the subscription id is not
-- the provider's identity. sent_endpoint_hash records the SHA-256 of the
-- endpoint the recording claim sent to, written with the other sent_* columns.
-- A hash, never the endpoint: the endpoint is a send capability.
--
-- NULL = unknown: no attempt recorded a send, or a replica that predates this
-- column sent it. Retained and deleted with the delivery row.
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS sent_endpoint_hash TEXT;

-- Same-endpoint lookup for the monitor's collapse check. NULL hashes are
-- indexed too: the check also looks for rivals whose endpoint is unknown.
CREATE INDEX IF NOT EXISTS idx_push_deliveries_sent_endpoint
  ON push_deliveries (workspace_id, sent_endpoint_hash, sent_topic);

-- Replaced by the endpoint lookup above; nothing else reads deliveries by subscription.
DROP INDEX IF EXISTS idx_push_deliveries_subscription;
