-- Reserved background uploads: an attachment row is created BEFORE its bytes
-- exist (safety_status = 'pending_upload') so a message can bind the id while
-- the upload continues. This table tracks the transient upload workflow per
-- INV-57 — durable file identity stays on `attachments`.
--
-- Row lifecycle: reserved -> uploading -> uploaded (scan window) -> row DELETED
-- on successful settle. Rows persist only for in-flight, failed, or abandoned
-- uploads, so presence of a row means "not settled".

CREATE TABLE IF NOT EXISTS attachment_uploads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL UNIQUE,
    uploaded_by TEXT NOT NULL,
    status TEXT NOT NULL,
    expected_size_bytes BIGINT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The stale-upload sweep scans by (status, updated_at).
CREATE INDEX IF NOT EXISTS idx_attachment_uploads_status_updated
    ON attachment_uploads (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_attachment_uploads_workspace
    ON attachment_uploads (workspace_id);
