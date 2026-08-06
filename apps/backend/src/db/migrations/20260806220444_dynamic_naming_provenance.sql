-- Add title provenance and monotonic revisions for rollout-safe naming writes.
ALTER TABLE streams
  ADD COLUMN display_name_source TEXT,
  ADD COLUMN display_name_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN display_name_updated_by_user_id TEXT;

ALTER TABLE conversations
  ADD COLUMN topic_summary_source TEXT,
  ADD COLUMN topic_summary_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN topic_summary_updated_by_user_id TEXT;

UPDATE streams s
SET display_name_source = 'legacy'
WHERE s.display_name IS NOT NULL
   OR EXISTS (
     SELECT 1 FROM e2e_streams e
     WHERE e.workspace_id = s.workspace_id
       AND e.stream_id = s.id
       AND e.name_ciphertext IS NOT NULL
   );

UPDATE conversations
SET topic_summary_source = 'legacy'
WHERE topic_summary IS NOT NULL;
