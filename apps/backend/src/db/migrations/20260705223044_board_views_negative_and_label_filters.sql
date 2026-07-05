-- Board saved views: negative (exclude) filter axes + label filters.
-- A saved view bookmarks the board's full filter state; these columns extend the
-- stored triple (lens + scope_stream_ids + scope_stream_types) with the
-- ?not-in= / ?not-is= / ?label= / ?not-label= axes.

ALTER TABLE board_views
    ADD COLUMN IF NOT EXISTS scope_label_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS exclude_stream_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS exclude_stream_types TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS exclude_label_ids TEXT[] NOT NULL DEFAULT '{}';
