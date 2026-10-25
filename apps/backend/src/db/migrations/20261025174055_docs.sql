-- Collaborative docs: a doc is a `doc` stream whose body is a Yjs document.
-- `docs` is the per-doc head (seq allocator, row lock, projected body);
-- `doc_updates` the append-only Yjs update log; `doc_snapshots` periodic full
-- states to replay from; `doc_sections` the per-top-level-block projection.
-- actor_type / kind are TEXT validated in code (INV-3). No foreign keys (INV-1).

CREATE TABLE IF NOT EXISTS docs (
    workspace_id TEXT NOT NULL,                -- INV-8
    stream_id TEXT PRIMARY KEY,
    update_seq INTEGER NOT NULL DEFAULT 0,
    snapshot_seq INTEGER NOT NULL DEFAULT 0,
    body_markdown TEXT NOT NULL DEFAULT '',
    body_json JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doc_updates (
    workspace_id TEXT NOT NULL,                -- INV-8
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    update BYTEA NOT NULL,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,                  -- AuthorType (INV-3)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS doc_snapshots (
    workspace_id TEXT NOT NULL,                -- INV-8
    doc_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    state BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS doc_sections (
    workspace_id TEXT NOT NULL,                -- INV-8
    doc_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,                        -- top-level node type (INV-3)
    markdown TEXT NOT NULL,
    content_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (doc_id, block_id)
);

CREATE INDEX IF NOT EXISTS doc_sections_position_idx ON doc_sections (doc_id, position);
