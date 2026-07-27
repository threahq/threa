-- Projection index behind the "In this stream" panel: one row per
-- (message x artifact) occurrence — links, media, files, memos, delegations,
-- threads — ordered by the SOURCE MESSAGE's created_at. Display data is joined
-- live at read; `detail` carries only what has no home row.

CREATE TABLE stream_context_items (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  stream_id         TEXT NOT NULL,
  root_stream_id    TEXT NOT NULL,
  category          TEXT NOT NULL,
  ref_kind          TEXT NOT NULL,
  ref_id            TEXT NOT NULL,
  group_key         TEXT NOT NULL,
  source_message_id TEXT,
  author_id         TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  sequence          BIGINT,
  snippet           TEXT NOT NULL DEFAULT '',
  detail            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX stream_context_items_identity
  ON stream_context_items (workspace_id, stream_id, category, ref_id, COALESCE(source_message_id, ''));
CREATE INDEX stream_context_items_feed
  ON stream_context_items (workspace_id, root_stream_id, occurred_at DESC, id DESC);
CREATE INDEX stream_context_items_feed_stream
  ON stream_context_items (workspace_id, stream_id, occurred_at DESC, id DESC);
CREATE INDEX stream_context_items_occurrences
  ON stream_context_items (workspace_id, root_stream_id, category, group_key, occurred_at DESC, id DESC);
CREATE INDEX stream_context_items_message
  ON stream_context_items (workspace_id, source_message_id);
