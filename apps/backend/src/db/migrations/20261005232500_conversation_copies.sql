-- Threa Connect: a partner's copy of a conversation in a shared channel keeps
-- the host's id and names the workspace it came from (NULL: this workspace's own).
--
-- `version` moves whenever a field the partner copies changes, so the partner
-- refetches only what moved. Trigger-owned, so replicas running the previous
-- build still bump it during the rolling deploy. A copy keeps the version its
-- host sent.
--
-- The two stamps name the shared channel a title or summary was written for,
-- read the way the partner reads it. NULL is one written outside a share,
-- which the partner never receives.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS origin_workspace_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS topic_summary_shared_root_stream_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary_shared_root_stream_id TEXT;

CREATE OR REPLACE FUNCTION bump_conversation_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.origin_workspace_id IS NULL THEN
    NEW.version := OLD.version + CASE
      WHEN (OLD.topic_summary, OLD.topic_summary_source, OLD.topic_summary_revision,
            OLD.topic_summary_shared_root_stream_id, OLD.summary, OLD.summary_shared_root_stream_id,
            OLD.status, OLD.message_ids, OLD.secondary_message_ids, OLD.participant_ids,
            OLD.last_activity_at, OLD.completeness_score, OLD.confidence)
        IS DISTINCT FROM (NEW.topic_summary, NEW.topic_summary_source, NEW.topic_summary_revision,
            NEW.topic_summary_shared_root_stream_id, NEW.summary, NEW.summary_shared_root_stream_id,
            NEW.status, NEW.message_ids, NEW.secondary_message_ids, NEW.participant_ids,
            NEW.last_activity_at, NEW.completeness_score, NEW.confidence)
      THEN 1 ELSE 0 END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_conversation_version ON conversations;
CREATE TRIGGER bump_conversation_version
BEFORE UPDATE ON conversations
FOR EACH ROW
EXECUTE FUNCTION bump_conversation_version();
