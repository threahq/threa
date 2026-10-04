SET LOCAL lock_timeout = '5s';

DROP INDEX idx_stream_briefs_stream;
ALTER INDEX idx_stream_briefs_stream_ws RENAME TO idx_stream_briefs_stream;
