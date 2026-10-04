SET LOCAL lock_timeout = '5s';

DROP INDEX idx_user_activity_dedup_non_reaction;
ALTER INDEX idx_user_activity_dedup_non_reaction_ws RENAME TO idx_user_activity_dedup_non_reaction;

DROP INDEX idx_user_activity_dedup_reaction;
ALTER INDEX idx_user_activity_dedup_reaction_ws RENAME TO idx_user_activity_dedup_reaction;
