SET LOCAL lock_timeout = '5s';

DROP INDEX idx_sca_stream_intent_unique;
ALTER INDEX idx_sca_stream_intent_unique_ws RENAME TO idx_sca_stream_intent_unique;
