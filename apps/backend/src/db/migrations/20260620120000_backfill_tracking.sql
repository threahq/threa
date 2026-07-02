-- Generic backfill framework tracking tables.
--
-- `backfill_runs`: one row per (backfill_name, workspace_id) — the plan worker
-- upserts it and fans out chunk jobs; the chunk worker increments completion
-- counters and flips status when all chunks land. UNIQUE(backfill_name,
-- workspace_id) makes re-planning idempotent (ON CONFLICT).
--
-- `backfill_chunks`: one row per processed chunk, keyed by (run_id, chunk_index).
-- The chunk worker INSERTs ON CONFLICT DO NOTHING so redelivery of an already
-- accounted chunk is a no-op — exactly-once accounting against the run counters.

CREATE TABLE backfill_runs (
    id TEXT PRIMARY KEY,                          -- bfrun_<ulid>
    backfill_name TEXT NOT NULL,
    workspace_id TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'planning',      -- planning | processing | completed | failed
    total_chunks INTEGER NOT NULL DEFAULT 0,
    chunks_completed INTEGER NOT NULL DEFAULT 0,
    chunks_failed INTEGER NOT NULL DEFAULT 0,
    items_processed INTEGER NOT NULL DEFAULT 0,

    params JSONB,
    error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    UNIQUE (backfill_name, workspace_id)
);

CREATE TABLE backfill_chunks (
    run_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (run_id, chunk_index)
);
