-- References a scheduled send carried without a share grant: the source began
-- exposing target readers after the author consented, so readers see the
-- private placeholder until the author shares it. Workflow state (INV-57),
-- cleared whenever the message's shares are recorded again.
-- flavor is TEXT validated in code (INV-3). No foreign keys (INV-1).

CREATE TABLE IF NOT EXISTS unshared_references (
    workspace_id TEXT NOT NULL,                -- INV-8
    share_message_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_stream_id TEXT NOT NULL,
    flavor TEXT NOT NULL,                      -- 'pointer' | 'quote' (INV-3)
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, share_message_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS unshared_references_creator_idx ON unshared_references (workspace_id, created_by);
