-- Index the retention sweep. github_webhook_deliveries grows one row per routed
-- webhook (every push to any PR branch across every installation) and is never
-- bounded elsewhere, so an hourly sweep deletes rows older than the retention
-- window. Without this index the sweep's `WHERE created_at < cutoff` is a seq
-- scan over the whole table; with it the delete's row-selection is a cheap
-- range scan.
CREATE INDEX idx_github_webhook_deliveries_created_at
    ON github_webhook_deliveries (created_at);
