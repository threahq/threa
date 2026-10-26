-- Roll-up cursor for doc activity rows (INV-57: workflow state, not on `docs`).
-- `folded_sequence` is the doc stream's `stream_events.sequence` through which
-- `doc:edited` rows have been folded into a host `doc:activity` row; `block_ids` is the
-- doc's top-level block ids at that fold (NULL before the first), so the next row can
-- name what was removed since. No foreign keys (INV-1).

CREATE TABLE IF NOT EXISTS doc_activity_state (
    workspace_id TEXT NOT NULL,                -- INV-8
    doc_id TEXT NOT NULL,
    folded_sequence BIGINT NOT NULL DEFAULT 0,
    block_ids TEXT[],
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, doc_id)
);
