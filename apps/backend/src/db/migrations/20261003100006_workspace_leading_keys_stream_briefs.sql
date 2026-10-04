SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX idx_stream_briefs_stream_ws ON stream_briefs (workspace_id, stream_id);
