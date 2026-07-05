-- User-saved board lenses (board-view-design.md § "Lenses" — the "save our own
-- lenses" ask). A saved view is a NAMED BOOKMARK of the board's URL state: a base
-- lens plus the stream (`?in=`) and stream-type (`?is=`) scopes. It round-trips
-- losslessly to `/board/:lens?in=…&is=…` — no new predicate, no new filter engine.
--
-- Unlike the per-(user) sidebar_configs, a view is an addressable, renamable
-- entity a picker lists, so it carries a surrogate prefixed-ULID id (INV-2), not a
-- composite PK. No FK (INV-1), no enum (INV-3, base_lens validated in code),
-- workspace_id scoped (INV-8).

CREATE TABLE IF NOT EXISTS board_views (
    id                 TEXT PRIMARY KEY,             -- boardview_<ulid>
    workspace_id       TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    name               TEXT NOT NULL,
    base_lens          TEXT NOT NULL,                -- one of BOARD_LENSES, validated in code
    scope_stream_ids   TEXT[] NOT NULL DEFAULT '{}',
    scope_stream_types TEXT[] NOT NULL DEFAULT '{}',
    sort_order         INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_views_user
    ON board_views (workspace_id, user_id, sort_order);
