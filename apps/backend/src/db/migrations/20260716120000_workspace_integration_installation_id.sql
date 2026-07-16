-- Plaintext reverse index for GitHub webhook fan-out. The installation id
-- rides in every webhook payload, so it is NOT a secret and lives in its own
-- column (only tokens stay AES-encrypted inside `credentials`). Given an
-- installation id from a webhook, the regional worker resolves every
-- subscribed workspace via (provider, installation_id).

ALTER TABLE workspace_integrations ADD COLUMN IF NOT EXISTS installation_id TEXT;

CREATE INDEX IF NOT EXISTS workspace_integrations_provider_installation
    ON workspace_integrations (provider, installation_id);
