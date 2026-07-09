-- Track asynchronous attachment uploads separately from attachment metadata.
-- Reservations create an attachment row before bytes exist; this table records
-- upload progress and correlates pending files with an optional client message.

CREATE TABLE IF NOT EXISTS attachment_uploads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL UNIQUE,
    uploaded_by TEXT NOT NULL,
    client_message_id TEXT,
    draft_id TEXT,
    status TEXT NOT NULL,
    expected_size_bytes BIGINT NOT NULL,
    received_size_bytes BIGINT,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_attachment_uploads_workspace_status
    ON attachment_uploads (workspace_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_attachment_uploads_client_message
    ON attachment_uploads (workspace_id, client_message_id)
    WHERE client_message_id IS NOT NULL;
