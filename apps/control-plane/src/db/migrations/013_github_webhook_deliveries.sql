-- Audit + idempotency ledger for inbound GitHub App webhooks. GitHub delivers
-- every installation's events to one URL; the control plane verifies the
-- signature, records the delivery, and fans one outbox dispatch event per
-- region hosting a subscribed workspace.
--
-- delivery_guid is GitHub's `X-GitHub-Delivery` header, unique per delivery.
-- A duplicate GUID (GitHub retry) hits the UNIQUE key and short-circuits so the
-- fan-out runs exactly once (INV-20). payload is the raw event body, read back
-- by the outbox dispatcher to forward to each region. No FKs (INV-1), no enums
-- (INV-3); status is TEXT validated in code.

CREATE TABLE github_webhook_deliveries (
    id TEXT PRIMARY KEY,
    delivery_guid TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    action TEXT,
    installation_id TEXT,
    repository_full_name TEXT,
    payload JSONB NOT NULL,
    matched_regions TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_webhook_deliveries_installation
    ON github_webhook_deliveries (installation_id);
