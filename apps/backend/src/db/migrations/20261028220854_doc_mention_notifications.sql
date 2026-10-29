-- Doc mention notifications. No foreign keys (INV-1).
--
-- doc_mention_state: per (doc, author) settling state (INV-57: workflow state, not on `docs`).
-- `settled_sequence` is the doc stream's `stream_events.sequence` through which this author's
-- `doc:edited` rows have settled; `last_block_ids` is what the author's latest block-touching
-- write touched, so the next write can tell the author left a block.
CREATE TABLE IF NOT EXISTS doc_mention_state (
    workspace_id TEXT NOT NULL,                -- INV-8
    doc_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    settled_sequence BIGINT NOT NULL DEFAULT 0,
    last_block_ids TEXT[],
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, doc_id, actor_id)
);

-- At most one notification per (doc, block, mentioned user), ever: a mention removed and
-- added again does not notify twice.
CREATE TABLE IF NOT EXISTS doc_mention_notifications (
    workspace_id TEXT NOT NULL,                -- INV-8
    doc_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, doc_id, block_id, user_id)
);

-- Mentions already in docs count as notified: without this, an author's first edit after deploy
-- settles every block they ever touched (their state row starts at sequence 0) and old mentions fire.
INSERT INTO doc_mention_notifications (workspace_id, doc_id, block_id, user_id, actor_id)
SELECT DISTINCT ds.workspace_id, ds.doc_id, ds.block_id, mention.id #>> '{}', 'system'
FROM doc_sections ds
CROSS JOIN LATERAL jsonb_path_query(ds.content_json, 'lax $.** ? (@.type == "mention").attrs.id') AS mention(id)
WHERE jsonb_typeof(mention.id) = 'string' AND mention.id #>> '{}' LIKE 'usr\_%'
ON CONFLICT DO NOTHING;
